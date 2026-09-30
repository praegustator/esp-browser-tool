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

#define FIRMWARE_NAME "esp-browser-tool-diag"
#define FIRMWARE_VERSION "1.0.0"
#define PROTOCOL_VERSION 1

#define SERIAL_BAUD 115200
#define MAX_LINE 512
#define MAX_WATCH 24
#define PWM_RESOLUTION 10
#define PWM_MAX ((1 << PWM_RESOLUTION) - 1)

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
