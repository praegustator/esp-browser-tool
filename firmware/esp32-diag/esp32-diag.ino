/*
 * ESP Browser Tool — diagnostic firmware
 * =====================================
 *
 * Turns an ESP32 into a live pin laboratory that the browser tool drives over
 * the USB serial link. The firmware never touches Wi-Fi, never stores
 * anything, and releases every pin it configured on request, so it is safe to
 * flash before moving on to ESPHome or a project firmware.
 *
 * Protocol: newline delimited JSON, one document per line. See docs/PROTOCOL.md.
 *
 * Build requirements
 *   - Arduino-ESP32 core 3.x (ESP-IDF 5.x)
 *   - ArduinoJson 7.x (Library Manager: "ArduinoJson" by Benoit Blanchon)
 *
 * Supported targets: ESP32, ESP32-S2, ESP32-S3, ESP32-C3 (and other RISC-V
 * variants without touch support).
 */

#include <Arduino.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include "mbedtls/base64.h"
#if SOC_ADC_DMA_SUPPORTED
#include "esp_adc/adc_continuous.h"
#endif

#define FIRMWARE_NAME "esp-browser-tool-diag"
#define FIRMWARE_VERSION "1.1.0"
#define PROTOCOL_VERSION 1

#define SERIAL_BAUD 115200
#define MAX_LINE 512
#define MAX_WATCH 24
#define PWM_RESOLUTION 10
#define PWM_MAX ((1 << PWM_RESOLUTION) - 1)

// Burst capture limits. Mirror src/protocol/types.ts and docs/PROTOCOL.md.
#define CAPTURE_MAX_SAMPLES 4096
#define CAPTURE_CHUNK_SAMPLES 512
#define CAPTURE_MIN_RATE 100
#define CAPTURE_MAX_RATE 2000000
#define CAPTURE_MAX_DURATION_MS 5000
/** Rates at or above this use the ADC DMA engine; below it, paced analogRead. */
#if SOC_ADC_DMA_SUPPORTED
#define CAPTURE_DMA_MIN_RATE SOC_ADC_SAMPLE_FREQ_THRES_LOW
#define CAPTURE_CHIP_MAX_RATE \
  (SOC_ADC_SAMPLE_FREQ_THRES_HIGH < CAPTURE_MAX_RATE ? SOC_ADC_SAMPLE_FREQ_THRES_HIGH \
                                                     : CAPTURE_MAX_RATE)
#else
#define CAPTURE_DMA_MIN_RATE 20001
#define CAPTURE_CHIP_MAX_RATE 20000
#endif

// ---------------------------------------------------------------- pin model

enum PinMode : uint8_t {
  MODE_DISABLED = 0,
  MODE_INPUT,
  MODE_INPUT_PULLUP,
  MODE_INPUT_PULLDOWN,
  MODE_OUTPUT,
  MODE_OUTPUT_OPEN_DRAIN,
  MODE_ANALOG,
  MODE_TOUCH,
  MODE_PWM,
};

struct PinState {
  PinMode mode = MODE_DISABLED;
  uint8_t level = 0;
  uint16_t blinkPeriod = 0;   // full period in ms, 0 = off
  uint32_t blinkNext = 0;
  uint32_t pulseUntil = 0;    // millis() deadline, 0 = no pulse pending
  uint8_t pulseRestore = 0;
  uint32_t pwmFreq = 0;
  float pwmDuty = 0.0f;
};

static PinState pins[SOC_GPIO_PIN_COUNT];
static int watchList[MAX_WATCH];
static size_t watchCount = 0;
static uint32_t watchInterval = 0;   // 0 = not watching
static uint32_t watchNext = 0;

static char lineBuffer[MAX_LINE];
static size_t lineLength = 0;

// ------------------------------------------------------------ pin utilities

/** Pins wired to the SPI flash or the USB console must never be touched. */
static bool isReservedPin(int pin) {
#if CONFIG_IDF_TARGET_ESP32
  if (pin >= 6 && pin <= 11) return true;       // SPI flash
  if (pin == 1 || pin == 3) return true;        // UART0 (this console)
  if (pin == 20 || pin == 24) return true;      // not bonded out
  if (pin >= 28 && pin <= 31) return true;      // not bonded out
#elif CONFIG_IDF_TARGET_ESP32S2
  if (pin >= 26 && pin <= 32) return true;      // SPI flash / PSRAM
  if (pin == 43 || pin == 44) return true;      // UART0
#elif CONFIG_IDF_TARGET_ESP32S3
  if (pin >= 26 && pin <= 32) return true;      // SPI flash / PSRAM
  if (pin >= 33 && pin <= 37) return true;      // octal PSRAM on -N8R8 modules
  if (pin == 43 || pin == 44) return true;      // UART0
#elif CONFIG_IDF_TARGET_ESP32C3
  if (pin >= 11 && pin <= 17) return true;      // SPI flash
  if (pin == 20 || pin == 21) return true;      // UART0
#endif
  return false;
}

static bool isValidPin(int pin) {
  if (pin < 0 || pin >= (int)SOC_GPIO_PIN_COUNT) return false;
  if (!digitalPinIsValid(pin)) return false;
  return !isReservedPin(pin);
}

static bool canOutput(int pin) {
#ifdef digitalPinCanOutput
  return digitalPinCanOutput(pin);
#else
  return !(pin >= 34 && pin <= 39);
#endif
}

static bool hasAdc(int pin) {
  int8_t channel = digitalPinToAnalogChannel(pin);
  return channel >= 0;
}

static bool hasTouch(int pin) {
#if SOC_TOUCH_SENSOR_SUPPORTED
  return digitalPinToTouchChannel(pin) >= 0;
#else
  (void)pin;
  return false;
#endif
}

static const char *modeName(PinMode mode) {
  switch (mode) {
    case MODE_INPUT: return "input";
    case MODE_INPUT_PULLUP: return "input_pullup";
    case MODE_INPUT_PULLDOWN: return "input_pulldown";
    case MODE_OUTPUT: return "output";
    case MODE_OUTPUT_OPEN_DRAIN: return "output_open_drain";
    case MODE_ANALOG: return "analog";
    case MODE_TOUCH: return "touch";
    case MODE_PWM: return "pwm";
    default: return "disabled";
  }
}

static bool parseMode(const char *name, PinMode &out) {
  if (!name) return false;
  if (!strcmp(name, "disabled")) { out = MODE_DISABLED; return true; }
  if (!strcmp(name, "input")) { out = MODE_INPUT; return true; }
  if (!strcmp(name, "input_pullup")) { out = MODE_INPUT_PULLUP; return true; }
  if (!strcmp(name, "input_pulldown")) { out = MODE_INPUT_PULLDOWN; return true; }
  if (!strcmp(name, "output")) { out = MODE_OUTPUT; return true; }
  if (!strcmp(name, "output_open_drain")) { out = MODE_OUTPUT_OPEN_DRAIN; return true; }
  if (!strcmp(name, "analog")) { out = MODE_ANALOG; return true; }
  if (!strcmp(name, "touch")) { out = MODE_TOUCH; return true; }
  if (!strcmp(name, "pwm")) { out = MODE_PWM; return true; }
  return false;
}

// -------------------------------------------------------------- transmitters

static void sendDocument(JsonDocument &doc) {
  serializeJson(doc, Serial);
  Serial.println();
}

static void sendOk(long id, JsonDocument &result) {
  JsonDocument doc;
  doc["id"] = id;
  doc["ok"] = true;
  doc["result"] = result;
  sendDocument(doc);
}

static void sendOkEmpty(long id) {
  JsonDocument doc;
  doc["id"] = id;
  doc["ok"] = true;
  sendDocument(doc);
}

static void sendError(long id, const char *code, const char *message) {
  JsonDocument doc;
  doc["id"] = id;
  doc["ok"] = false;
  JsonObject error = doc["error"].to<JsonObject>();
  error["code"] = code;
  error["message"] = message;
  sendDocument(doc);
}

static void sendLog(const char *level, const char *message) {
  JsonDocument doc;
  doc["ev"] = "log";
  doc["level"] = level;
  doc["message"] = message;
  sendDocument(doc);
}

static void fillInfo(JsonObject info) {
  info["protocol"] = PROTOCOL_VERSION;
  info["firmware"] = FIRMWARE_NAME " " FIRMWARE_VERSION;
  info["chip"] = ESP.getChipModel();
  info["cores"] = ESP.getChipCores();
  info["revision"] = ESP.getChipRevision();
  info["flashSize"] = ESP.getFlashChipSize();
  info["freeHeap"] = ESP.getFreeHeap();
  info["maxWatch"] = MAX_WATCH;
  info["adcMax"] = (1 << 12) - 1;

  char mac[18];
  uint64_t chipId = ESP.getEfuseMac();
  snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
           (uint8_t)(chipId >> 40), (uint8_t)(chipId >> 32), (uint8_t)(chipId >> 24),
           (uint8_t)(chipId >> 16), (uint8_t)(chipId >> 8), (uint8_t)chipId);
  info["mac"] = mac;

  JsonArray available = info["pins"].to<JsonArray>();
  for (int pin = 0; pin < (int)SOC_GPIO_PIN_COUNT; pin++) {
    if (isValidPin(pin)) available.add(pin);
  }

  JsonObject capture = info["capture"].to<JsonObject>();
  capture["maxSamples"] = CAPTURE_MAX_SAMPLES;
  capture["minRate"] = CAPTURE_MIN_RATE;
  capture["maxRate"] = (uint32_t)CAPTURE_CHIP_MAX_RATE;

  JsonArray bauds = info["bauds"].to<JsonArray>();
  bauds.add(115200);
  bauds.add(230400);
  bauds.add(460800);
  bauds.add(921600);
}

static void sendReady() {
  JsonDocument doc;
  doc["ev"] = "ready";
  fillInfo(doc["info"].to<JsonObject>());
  sendDocument(doc);
}

// ------------------------------------------------------------- pin plumbing

static void releasePin(int pin) {
  PinState &state = pins[pin];
  if (state.mode == MODE_PWM && state.pwmFreq > 0) {
    ledcDetach(pin);
  }
  state.mode = MODE_DISABLED;
  state.level = 0;
  state.blinkPeriod = 0;
  state.blinkNext = 0;
  state.pulseUntil = 0;
  state.pwmFreq = 0;
  state.pwmDuty = 0.0f;
  pinMode(pin, INPUT);
}

static bool applyMode(int pin, PinMode mode, const char **error) {
  PinState &state = pins[pin];
  if (state.mode == MODE_PWM && mode != MODE_PWM && state.pwmFreq > 0) {
    ledcDetach(pin);
    state.pwmFreq = 0;
  }
  switch (mode) {
    case MODE_DISABLED:
      releasePin(pin);
      return true;
    case MODE_INPUT:
      pinMode(pin, INPUT);
      break;
    case MODE_INPUT_PULLUP:
      if (!canOutput(pin)) { *error = "this pin has no internal pull-up"; return false; }
      pinMode(pin, INPUT_PULLUP);
      break;
    case MODE_INPUT_PULLDOWN:
      if (!canOutput(pin)) { *error = "this pin has no internal pull-down"; return false; }
      pinMode(pin, INPUT_PULLDOWN);
      break;
    case MODE_OUTPUT:
      if (!canOutput(pin)) { *error = "this pin is input only"; return false; }
      pinMode(pin, OUTPUT);
      digitalWrite(pin, state.level ? HIGH : LOW);
      break;
    case MODE_OUTPUT_OPEN_DRAIN:
      if (!canOutput(pin)) { *error = "this pin is input only"; return false; }
      pinMode(pin, OUTPUT_OPEN_DRAIN);
      digitalWrite(pin, state.level ? HIGH : LOW);
      break;
    case MODE_ANALOG:
      if (!hasAdc(pin)) { *error = "this pin has no ADC channel"; return false; }
      pinMode(pin, INPUT);
      analogSetPinAttenuation(pin, ADC_11db);
      break;
    case MODE_TOUCH:
      if (!hasTouch(pin)) { *error = "this pin has no touch channel"; return false; }
      break;
    case MODE_PWM: {
      if (!canOutput(pin)) { *error = "this pin is input only"; return false; }
      uint32_t freq = state.pwmFreq > 0 ? state.pwmFreq : 1000;
      if (!ledcAttach(pin, freq, PWM_RESOLUTION)) {
        *error = "no free LEDC timer for this pin";
        return false;
      }
      state.pwmFreq = freq;
      ledcWrite(pin, (uint32_t)(state.pwmDuty * PWM_MAX));
      break;
    }
  }
  state.mode = mode;
  state.blinkPeriod = 0;
  state.pulseUntil = 0;
  return true;
}

/** Fill `target` with the current reading of `pin`, according to its mode. */
static void samplePin(int pin, JsonObject target) {
  PinState &state = pins[pin];
  switch (state.mode) {
    case MODE_ANALOG: {
      int raw = analogRead(pin);
      target["a"] = raw;
      target["mv"] = analogReadMilliVolts(pin);
      break;
    }
    case MODE_TOUCH: {
#if SOC_TOUCH_SENSOR_SUPPORTED
      uint32_t value = touchRead(pin);
      target["t"] = value;
#endif
      break;
    }
    case MODE_PWM:
      target["d"] = digitalRead(pin) == HIGH ? 1 : 0;
      target["a"] = (int)(state.pwmDuty * PWM_MAX);
      break;
    case MODE_DISABLED:
      break;
    default:
      target["d"] = digitalRead(pin) == HIGH ? 1 : 0;
      break;
  }
}

static void setWatchList(JsonArray requested, uint32_t interval) {
  watchCount = 0;
  for (JsonVariant value : requested) {
    if (watchCount >= MAX_WATCH) break;
    int pin = value.as<int>();
    if (!isValidPin(pin)) continue;
    watchList[watchCount++] = pin;
  }
  watchInterval = watchCount > 0 ? interval : 0;
  watchNext = millis();
}

static void emitSamples() {
  JsonDocument doc;
  doc["ev"] = "sample";
  doc["t"] = millis();
  JsonObject pinsOut = doc["pins"].to<JsonObject>();
  char key[4];
  for (size_t index = 0; index < watchCount; index++) {
    int pin = watchList[index];
    snprintf(key, sizeof(key), "%d", pin);
    samplePin(pin, pinsOut[key].to<JsonObject>());
  }
  sendDocument(doc);
}

// ------------------------------------------------------------- burst capture

/** One static buffer (8 KB) — capture is strictly one pin at a time. */
static uint16_t captureBuffer[CAPTURE_MAX_SAMPLES];

struct CaptureTriggerSpec {
  bool enabled = false;
  bool rising = true;
  uint16_t level = 0;        // raw ADC counts
  uint32_t timeoutMs = 1000;
};

/**
 * Feed samples in one at a time; handles the pre-trigger ring buffer, edge
 * detection and final linearisation so both sampling paths share the logic.
 * The pre-trigger ring lives in captureBuffer[0..preCount) and is rotated in
 * place once the trigger fires; sample[preCount] is the triggering sample.
 */
struct CaptureEngine {
  size_t preCount = 0;
  size_t total = 0;
  CaptureTriggerSpec trigger;

  size_t ringFill = 0;
  size_t ringPos = 0;
  size_t postFill = 0;
  bool fired = false;
  bool havePrev = false;
  uint16_t prev = 0;

  void begin(size_t totalSamples, size_t pretriggerSamples, const CaptureTriggerSpec &spec) {
    total = totalSamples;
    trigger = spec;
    preCount = spec.enabled ? pretriggerSamples : 0;
    ringFill = 0;
    ringPos = 0;
    postFill = 0;
    fired = !spec.enabled;
    havePrev = false;
    prev = 0;
  }

  bool done() const { return fired && preCount + postFill >= total; }

  void push(uint16_t sample) {
    if (fired) {
      if (preCount + postFill < total) captureBuffer[preCount + postFill++] = sample;
      return;
    }
    bool edge = false;
    if (havePrev && ringFill >= preCount) {
      edge = trigger.rising ? (prev < trigger.level && sample >= trigger.level)
                            : (prev > trigger.level && sample <= trigger.level);
    }
    prev = sample;
    havePrev = true;
    if (edge) {
      fired = true;
      unwrapRing();
      if (preCount + postFill < total) captureBuffer[preCount + postFill++] = sample;
      return;
    }
    if (preCount > 0) {
      captureBuffer[ringPos] = sample;
      ringPos = (ringPos + 1) % preCount;
      if (ringFill < preCount) ringFill++;
    }
  }

private:
  /** Rotate the ring so its oldest sample lands at captureBuffer[0]. */
  void unwrapRing() {
    if (preCount == 0) return;
    size_t start = ringFill < preCount ? 0 : ringPos;
    reverseRange(0, start);
    reverseRange(start, preCount);
    reverseRange(0, preCount);
  }

  static void reverseRange(size_t from, size_t to) {
    while (from + 1 < to) {
      to--;
      uint16_t swap = captureBuffer[from];
      captureBuffer[from] = captureBuffer[to];
      captureBuffer[to] = swap;
      from++;
    }
  }
};

/** Sample with micros()-paced analogRead; used below the DMA engine's range. */
static bool captureSlow(int pin, uint32_t rate, CaptureEngine &engine, const char **error) {
  uint32_t periodUs = 1000000UL / rate;
  uint32_t triggerDeadline = millis() + engine.trigger.timeoutMs;
  uint32_t nextUs = micros();
  while (!engine.done()) {
    if (!engine.fired && (int32_t)(millis() - triggerDeadline) >= 0) {
      *error = "trigger_timeout";
      return false;
    }
    while ((int32_t)(micros() - nextUs) < 0) {
    }
    nextUs += periodUs;
    engine.push((uint16_t)analogRead(pin));
  }
  return true;
}

#if SOC_ADC_DMA_SUPPORTED
#if CONFIG_IDF_TARGET_ESP32 || CONFIG_IDF_TARGET_ESP32S2
#define CAPTURE_OUTPUT_FORMAT ADC_DIGI_OUTPUT_FORMAT_TYPE1
#define CAPTURE_FRAME_DATA(p) ((p)->type1.data)
#define CAPTURE_FRAME_CHANNEL(p) ((p)->type1.channel)
#else
#define CAPTURE_OUTPUT_FORMAT ADC_DIGI_OUTPUT_FORMAT_TYPE2
#define CAPTURE_FRAME_DATA(p) ((p)->type2.data)
#define CAPTURE_FRAME_CHANNEL(p) ((p)->type2.channel)
#endif

/** Sample with the ADC continuous (DMA) driver; ADC1 channels only. */
static bool captureFast(int pin, uint32_t rate, CaptureEngine &engine, const char **error) {
  int8_t channel = digitalPinToAnalogChannel(pin);
  if (channel < 0 || channel >= SOC_ADC1_CHANNEL_NUM) {
    *error = "no_adc1";
    return false;
  }

  adc_continuous_handle_t handle = NULL;
  adc_continuous_handle_cfg_t handleCfg = {};
  handleCfg.max_store_buf_size = 4096;
  handleCfg.conv_frame_size = 256;
  if (adc_continuous_new_handle(&handleCfg, &handle) != ESP_OK) {
    *error = "capture_failed";
    return false;
  }

  adc_digi_pattern_config_t pattern = {};
  pattern.atten = ADC_ATTEN_DB_11;
  pattern.channel = (uint8_t)channel;
  pattern.unit = ADC_UNIT_1;
  pattern.bit_width = SOC_ADC_DIGI_MAX_BITWIDTH;

  adc_continuous_config_t digiCfg = {};
  digiCfg.pattern_num = 1;
  digiCfg.adc_pattern = &pattern;
  digiCfg.sample_freq_hz = rate;
  digiCfg.conv_mode = ADC_CONV_SINGLE_UNIT_1;
  digiCfg.format = CAPTURE_OUTPUT_FORMAT;
  if (adc_continuous_config(handle, &digiCfg) != ESP_OK ||
      adc_continuous_start(handle) != ESP_OK) {
    adc_continuous_deinit(handle);
    *error = "capture_failed";
    return false;
  }

  bool ok = true;
  uint32_t captureMs = (uint32_t)((uint64_t)engine.total * 1000 / rate);
  uint32_t triggerDeadline = millis() + engine.trigger.timeoutMs;
  uint32_t hardDeadline = millis() + engine.trigger.timeoutMs + captureMs + 2000;
  static uint8_t frame[256];
  while (!engine.done()) {
    if (!engine.fired && (int32_t)(millis() - triggerDeadline) >= 0) {
      *error = "trigger_timeout";
      ok = false;
      break;
    }
    if ((int32_t)(millis() - hardDeadline) >= 0) {
      *error = "capture_failed";
      ok = false;
      break;
    }
    uint32_t length = 0;
    esp_err_t err = adc_continuous_read(handle, frame, sizeof(frame), &length, 20);
    if (err == ESP_ERR_TIMEOUT) continue;
    if (err != ESP_OK) {
      *error = "capture_failed";
      ok = false;
      break;
    }
    for (uint32_t i = 0; i + SOC_ADC_DIGI_RESULT_BYTES <= length && !engine.done();
         i += SOC_ADC_DIGI_RESULT_BYTES) {
      adc_digi_output_data_t *p = (adc_digi_output_data_t *)&frame[i];
      if (CAPTURE_FRAME_CHANNEL(p) != (uint32_t)channel) continue;
      engine.push((uint16_t)CAPTURE_FRAME_DATA(p));
    }
  }

  adc_continuous_stop(handle);
  adc_continuous_deinit(handle);
  return ok;
}
#endif  // SOC_ADC_DMA_SUPPORTED

/** Stream the capture buffer back as base64 chunks of little-endian uint16. */
static void sendCaptureChunks(int pin, uint32_t rate, size_t samples, uint32_t t0) {
  size_t chunkCount = (samples + CAPTURE_CHUNK_SAMPLES - 1) / CAPTURE_CHUNK_SAMPLES;
  static char encoded[((CAPTURE_CHUNK_SAMPLES * 2 + 2) / 3) * 4 + 4];
  for (size_t seq = 0; seq < chunkCount; seq++) {
    size_t offset = seq * CAPTURE_CHUNK_SAMPLES;
    size_t count = samples - offset;
    if (count > CAPTURE_CHUNK_SAMPLES) count = CAPTURE_CHUNK_SAMPLES;
    size_t written = 0;
    // uint16_t is little endian on every ESP32 target, matching the protocol.
    if (mbedtls_base64_encode((unsigned char *)encoded, sizeof(encoded), &written,
                              (const unsigned char *)&captureBuffer[offset], count * 2) != 0) {
      sendLog("error", "capture chunk encode failed");
      return;
    }
    encoded[written] = '\0';
    JsonDocument doc;
    doc["ev"] = "capture";
    doc["pin"] = pin;
    doc["seq"] = (uint32_t)seq;
    doc["chunks"] = (uint32_t)chunkCount;
    doc["n"] = (uint32_t)count;
    doc["t0"] = t0;
    doc["rate"] = rate;
    doc["data"] = encoded;
    sendDocument(doc);
  }
}

// ------------------------------------------------------------- command layer

static bool requirePin(long id, JsonDocument &doc, int &pin) {
  if (!doc["pin"].is<int>()) {
    sendError(id, "bad_request", "missing \"pin\"");
    return false;
  }
  pin = doc["pin"].as<int>();
  if (!isValidPin(pin)) {
    sendError(id, "bad_pin", "this GPIO is not available or is reserved by the board");
    return false;
  }
  return true;
}

static bool requireOutput(long id, int pin) {
  PinState &state = pins[pin];
  if (state.mode != MODE_OUTPUT && state.mode != MODE_OUTPUT_OPEN_DRAIN && state.mode != MODE_PWM) {
    sendError(id, "bad_mode", "configure the pin as an output first");
    return false;
  }
  return true;
}

/**
 * Make sure `pin` really is a plain digital output before driving it: a pin
 * still attached to the LEDC peripheral ignores digitalWrite().
 */
static void ensureDigitalOutput(int pin) {
  PinState &state = pins[pin];
  if (state.mode == MODE_PWM) {
    if (state.pwmFreq > 0) ledcDetach(pin);
    state.pwmFreq = 0;
    state.pwmDuty = 0.0f;
    state.mode = MODE_OUTPUT;
    pinMode(pin, OUTPUT);
  }
}

static void driveLevel(int pin, uint8_t level) {
  ensureDigitalOutput(pin);
  pins[pin].level = level;
  digitalWrite(pin, level ? HIGH : LOW);
}

static void handleCommand(JsonDocument &doc) {
  long id = doc["id"].as<long>();
  const char *cmd = doc["cmd"];
  if (!cmd) {
    sendError(id, "bad_request", "missing \"cmd\"");
    return;
  }

  if (!strcmp(cmd, "hello") || !strcmp(cmd, "sys.info")) {
    JsonDocument result;
    fillInfo(result.to<JsonObject>());
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "sys.reset")) {
    sendOkEmpty(id);
    Serial.flush();
    delay(50);
    ESP.restart();
    return;
  }

  if (!strcmp(cmd, "pin.mode")) {
    int pin;
    if (!requirePin(id, doc, pin)) return;
    PinMode mode;
    if (!parseMode(doc["mode"], mode)) {
      sendError(id, "bad_request", "unknown pin mode");
      return;
    }
    const char *error = "unsupported mode for this pin";
    if (!applyMode(pin, mode, &error)) {
      sendError(id, "bad_mode", error);
      return;
    }
    JsonDocument result;
    result["pin"] = pin;
    result["mode"] = modeName(mode);
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.read")) {
    int pin;
    if (!requirePin(id, doc, pin)) return;
    JsonDocument result;
    JsonObject object = result.to<JsonObject>();
    object["pin"] = pin;
    samplePin(pin, object);
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.write")) {
    int pin;
    if (!requirePin(id, doc, pin) || !requireOutput(id, pin)) return;
    uint8_t value = doc["value"].as<int>() ? 1 : 0;
    pins[pin].blinkPeriod = 0;
    pins[pin].pulseUntil = 0;
    driveLevel(pin, value);
    JsonDocument result;
    result["pin"] = pin;
    result["value"] = value;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.toggle")) {
    int pin;
    if (!requirePin(id, doc, pin) || !requireOutput(id, pin)) return;
    uint8_t value = pins[pin].level ? 0 : 1;
    driveLevel(pin, value);
    JsonDocument result;
    result["pin"] = pin;
    result["value"] = value;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.pulse")) {
    int pin;
    if (!requirePin(id, doc, pin) || !requireOutput(id, pin)) return;
    uint8_t value = doc["value"].as<int>() ? 1 : 0;
    long ms = doc["ms"].as<long>();
    if (ms <= 0 || ms > 60000) {
      sendError(id, "bad_request", "\"ms\" must be within 1..60000");
      return;
    }
    pins[pin].pulseRestore = value ? 0 : 1;
    pins[pin].pulseUntil = millis() + (uint32_t)ms;
    driveLevel(pin, value);
    JsonDocument result;
    result["pin"] = pin;
    result["value"] = value;
    result["ms"] = ms;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.pwm")) {
    int pin;
    if (!requirePin(id, doc, pin)) return;
    if (!canOutput(pin)) {
      sendError(id, "input_only", "this pin is input only");
      return;
    }
    uint32_t freq = doc["freq"].as<uint32_t>();
    float duty = doc["duty"].as<float>();
    if (freq < 1 || freq > 40000 || duty < 0.0f || duty > 1.0f) {
      sendError(id, "bad_request", "freq must be 1..40000 and duty 0..1");
      return;
    }
    PinState &state = pins[pin];
    if (state.mode == MODE_PWM && state.pwmFreq > 0) ledcDetach(pin);
    if (!ledcAttach(pin, freq, PWM_RESOLUTION)) {
      sendError(id, "no_timer", "no free LEDC timer for this pin");
      return;
    }
    state.mode = MODE_PWM;
    state.pwmFreq = freq;
    state.pwmDuty = duty;
    state.blinkPeriod = 0;
    ledcWrite(pin, (uint32_t)(duty * PWM_MAX));
    JsonDocument result;
    result["pin"] = pin;
    result["freq"] = freq;
    result["duty"] = duty;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.blink")) {
    int pin;
    if (!requirePin(id, doc, pin) || !requireOutput(id, pin)) return;
    long period = doc["period"].as<long>();
    if (period < 0 || period > 60000) {
      sendError(id, "bad_request", "\"period\" must be within 0..60000");
      return;
    }
    pins[pin].blinkPeriod = (uint16_t)period;
    pins[pin].blinkNext = millis();
    JsonDocument result;
    result["pin"] = pin;
    result["period"] = period;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "pin.reset")) {
    if (doc["pin"].is<int>()) {
      int pin;
      if (!requirePin(id, doc, pin)) return;
      releasePin(pin);
      JsonDocument result;
      result["pin"] = pin;
      result["reset"] = true;
      sendOk(id, result);
      return;
    }
    for (int pin = 0; pin < (int)SOC_GPIO_PIN_COUNT; pin++) {
      if (isValidPin(pin) && pins[pin].mode != MODE_DISABLED) releasePin(pin);
    }
    watchCount = 0;
    watchInterval = 0;
    JsonDocument result;
    result["reset"] = "all";
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "watch.set")) {
    JsonArray requested = doc["pins"].as<JsonArray>();
    uint32_t interval = doc["interval"].as<uint32_t>();
    if (requested.isNull() || interval < 5 || interval > 10000) {
      sendError(id, "bad_request", "\"pins\" must be an array and \"interval\" 5..10000");
      return;
    }
    setWatchList(requested, interval);
    JsonDocument result;
    JsonArray echo = result["pins"].to<JsonArray>();
    for (size_t index = 0; index < watchCount; index++) echo.add(watchList[index]);
    result["interval"] = watchInterval;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "watch.clear")) {
    watchCount = 0;
    watchInterval = 0;
    JsonDocument result;
    result["pins"].to<JsonArray>();
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "scan.i2c")) {
    int sda = doc["sda"].as<int>();
    int scl = doc["scl"].as<int>();
    if (!isValidPin(sda) || !isValidPin(scl) || sda == scl) {
      sendError(id, "bad_pin", "invalid SDA/SCL pins");
      return;
    }
    uint32_t freq = doc["freq"].is<uint32_t>() ? doc["freq"].as<uint32_t>() : 100000;
    JsonDocument result;
    result["sda"] = sda;
    result["scl"] = scl;
    JsonArray devices = result["devices"].to<JsonArray>();
    Wire.end();
    if (!Wire.begin(sda, scl, freq)) {
      sendError(id, "i2c_failed", "could not start the I2C bus on these pins");
      return;
    }
    for (uint8_t address = 1; address < 127; address++) {
      Wire.beginTransmission(address);
      if (Wire.endTransmission() == 0) devices.add(address);
      delay(1);
    }
    Wire.end();
    // The scan reconfigures both pins; hand them back in a known state.
    pinMode(sda, INPUT);
    pinMode(scl, INPUT);
    pins[sda].mode = MODE_INPUT;
    pins[scl].mode = MODE_INPUT;
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "scan.pins")) {
    JsonDocument result;
    JsonArray list = result["pins"].to<JsonArray>();
    JsonArray requested = doc["pins"].as<JsonArray>();
    if (!requested.isNull()) {
      for (JsonVariant value : requested) {
        int pin = value.as<int>();
        if (!isValidPin(pin)) continue;
        JsonObject entry = list.add<JsonObject>();
        entry["pin"] = pin;
        samplePin(pin, entry);
      }
    } else {
      for (int pin = 0; pin < (int)SOC_GPIO_PIN_COUNT; pin++) {
        if (!isValidPin(pin)) continue;
        JsonObject entry = list.add<JsonObject>();
        entry["pin"] = pin;
        entry["d"] = digitalRead(pin) == HIGH ? 1 : 0;
      }
    }
    sendOk(id, result);
    return;
  }

  if (!strcmp(cmd, "sys.baud")) {
    uint32_t baud = doc["baud"].as<uint32_t>();
    if (baud != 115200 && baud != 230400 && baud != 460800 && baud != 921600) {
      sendError(id, "bad_request", "unsupported baud rate");
      return;
    }
    JsonDocument result;
    result["baud"] = baud;
    sendOk(id, result);
#if !ARDUINO_USB_CDC_ON_BOOT
    // Native USB ports ignore the baud rate; a real UART must switch after
    // the acknowledgement has fully left at the old speed.
    Serial.flush();
    delay(30);
    Serial.updateBaudRate(baud);
#endif
    return;
  }

  if (!strcmp(cmd, "adc.capture")) {
    int pin;
    if (!requirePin(id, doc, pin)) return;
    if (!hasAdc(pin)) {
      sendError(id, "bad_mode", "this pin has no ADC channel");
      return;
    }
    uint32_t rate = doc["rate"].as<uint32_t>();
    uint32_t samples = doc["samples"].as<uint32_t>();
    if (rate < CAPTURE_MIN_RATE || rate > CAPTURE_MAX_RATE || samples < 16 ||
        samples > CAPTURE_MAX_SAMPLES) {
      sendError(id, "bad_request", "rate must be 100..2000000 and samples 16..4096");
      return;
    }
    if (rate > CAPTURE_CHIP_MAX_RATE) rate = CAPTURE_CHIP_MAX_RATE;
    if ((uint64_t)samples * 1000 / rate > CAPTURE_MAX_DURATION_MS) {
      sendError(id, "bad_request", "capture longer than 5000 ms");
      return;
    }

    float pretrigger = doc["pretrigger"].is<float>() ? doc["pretrigger"].as<float>() : 0.0f;
    if (pretrigger < 0.0f || pretrigger > 0.9f) {
      sendError(id, "bad_request", "\"pretrigger\" must be within 0..0.9");
      return;
    }

    CaptureTriggerSpec trigger;
    JsonObject triggerSpec = doc["trigger"].as<JsonObject>();
    if (!triggerSpec.isNull()) {
      const char *edge = triggerSpec["edge"];
      if (!edge || (strcmp(edge, "rising") && strcmp(edge, "falling"))) {
        sendError(id, "bad_request", "trigger edge must be \"rising\" or \"falling\"");
        return;
      }
      long mv = triggerSpec["mv"].as<long>();
      if (mv < 0 || mv > 3600) {
        sendError(id, "bad_request", "trigger \"mv\" must be within 0..3600");
        return;
      }
      trigger.enabled = true;
      trigger.rising = !strcmp(edge, "rising");
      long raw = mv * 4095 / 3300;
      trigger.level = raw > 4095 ? 4095 : (uint16_t)raw;
      if (triggerSpec["timeoutMs"].is<uint32_t>()) {
        uint32_t timeoutMs = triggerSpec["timeoutMs"].as<uint32_t>();
        if (timeoutMs < 1 || timeoutMs > 10000) {
          sendError(id, "bad_request", "trigger \"timeoutMs\" must be within 1..10000");
          return;
        }
        trigger.timeoutMs = timeoutMs;
      }
    }

    CaptureEngine engine;
    engine.begin(samples, (size_t)(samples * pretrigger), trigger);

    const char *error = "capture_failed";
    uint32_t t0 = millis();
    bool ok;
#if SOC_ADC_DMA_SUPPORTED
    if (rate >= CAPTURE_DMA_MIN_RATE) {
      ok = captureFast(pin, rate, engine, &error);
    } else {
      ok = captureSlow(pin, rate, engine, &error);
    }
#else
    ok = captureSlow(pin, rate, engine, &error);
#endif
    if (!ok) {
      sendError(id, error,
                !strcmp(error, "trigger_timeout") ? "no matching edge before the timeout"
                : !strcmp(error, "no_adc1")       ? "this rate needs an ADC1 pin"
                                                  : "the ADC capture failed");
      return;
    }

    size_t chunkCount = (samples + CAPTURE_CHUNK_SAMPLES - 1) / CAPTURE_CHUNK_SAMPLES;
    JsonDocument result;
    result["pin"] = pin;
    result["rate"] = rate;
    result["samples"] = samples;
    result["chunks"] = (uint32_t)chunkCount;
    result["t0"] = t0;
    result["triggered"] = trigger.enabled;
    sendOk(id, result);
    sendCaptureChunks(pin, rate, samples, t0);
    return;
  }

  sendError(id, "unknown_command", cmd);
}

static void handleLine(char *line) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, line);
  if (error) {
    JsonDocument event;
    event["ev"] = "error";
    JsonObject payload = event["error"].to<JsonObject>();
    payload["code"] = "bad_json";
    payload["message"] = error.c_str();
    sendDocument(event);
    return;
  }
  handleCommand(doc);
}

// ------------------------------------------------------------ timed effects

static void serviceTimers() {
  uint32_t now = millis();
  for (int pin = 0; pin < (int)SOC_GPIO_PIN_COUNT; pin++) {
    PinState &state = pins[pin];
    if (state.mode != MODE_OUTPUT && state.mode != MODE_OUTPUT_OPEN_DRAIN) continue;
    if (state.pulseUntil != 0 && (int32_t)(now - state.pulseUntil) >= 0) {
      state.pulseUntil = 0;
      driveLevel(pin, state.pulseRestore);
    }
    if (state.blinkPeriod > 0 && (int32_t)(now - state.blinkNext) >= 0) {
      state.blinkNext = now + state.blinkPeriod / 2;
      driveLevel(pin, state.level ? 0 : 1);
    }
  }
  if (watchInterval > 0 && (int32_t)(now - watchNext) >= 0) {
    watchNext = now + watchInterval;
    emitSamples();
  }
}

// -------------------------------------------------------------------- setup

void setup() {
  Serial.begin(SERIAL_BAUD);
  Serial.setTimeout(50);
  analogReadResolution(12);
  delay(200);
  sendLog("info", FIRMWARE_NAME " " FIRMWARE_VERSION " ready");
  sendReady();
}

void loop() {
  while (Serial.available() > 0) {
    int incoming = Serial.read();
    if (incoming < 0) break;
    char character = (char)incoming;
    if (character == '\n' || character == '\r') {
      if (lineLength > 0) {
        lineBuffer[lineLength] = '\0';
        handleLine(lineBuffer);
        lineLength = 0;
      }
    } else if (lineLength < MAX_LINE - 1) {
      lineBuffer[lineLength++] = character;
    } else {
      // Overlong line: drop it rather than corrupting the next command.
      lineLength = 0;
      sendLog("warn", "command line too long, dropped");
    }
  }
  serviceTimers();
}
