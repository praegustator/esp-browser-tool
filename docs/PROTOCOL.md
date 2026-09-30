# ESP Browser Tool — wire protocol v1

The browser and the diagnostic firmware exchange **newline delimited JSON**
over the USB serial link at **115200 baud, 8N1**. Exactly one JSON document per
line, in both directions. Anything that is not valid protocol JSON (the ROM
bootloader banner, `Serial.println` debugging, …) is shown verbatim in the tool
console instead of being parsed.

```
host  ──▶ {"id":1,"cmd":"hello","protocol":1}
device ◀─ {"id":1,"ok":true,"result":{"protocol":1,"chip":"ESP32-D0WD-V3",...}}
device ◀─ {"ev":"sample","t":12345,"pins":{"2":{"d":1},"34":{"a":2048,"mv":1650}}}
```

## Messages

### Requests (host → device)

Every request carries a unique, increasing `id` and a `cmd`. The device answers
each request with exactly one response bearing the same `id`.

| `cmd` | Payload | Effect |
| --- | --- | --- |
| `hello` | `protocol` | Handshake; answers with the device info object. |
| `sys.info` | — | Device info object. |
| `sys.reset` | — | Reboots the board (the response is sent first). |
| `pin.mode` | `pin`, `mode` | Configures a pin (see modes below). |
| `pin.read` | `pin` | One-shot measurement of a pin. |
| `pin.write` | `pin`, `value` (`0`/`1`) | Drives an output pin. |
| `pin.toggle` | `pin` | Inverts an output pin. |
| `pin.pulse` | `pin`, `value`, `ms` | Drives `value` for `ms`, then the inverse. |
| `pin.pwm` | `pin`, `freq` (1–40000 Hz), `duty` (0–1) | Starts hardware PWM. |
| `pin.blink` | `pin`, `period` (ms, `0` stops) | Software blink on an output. |
| `pin.reset` | `pin` (optional) | Releases one pin, or all of them. |
| `watch.set` | `pins[]`, `interval` (5–10000 ms) | Starts streaming `sample` events. |
| `watch.clear` | — | Stops streaming. |
| `scan.i2c` | `sda`, `scl`, `freq?` | Probes addresses 0x01–0x7e. |
| `scan.pins` | `pins?` | Reads many pins at once. |

### Pin modes

| Mode | Meaning |
| --- | --- |
| `disabled` | Released, high impedance. The firmware stops touching it. |
| `input` | Plain input, no internal resistor (floating pins read noise). |
| `input_pullup` | Input with the internal pull-up — the default for probing. |
| `input_pulldown` | Input with the internal pull-down. |
| `output` | Push-pull output. |
| `output_open_drain` | Open-drain output (needs an external pull-up). |
| `analog` | ADC input, 12 bit, 11 dB attenuation (≈0–3.3 V). |
| `touch` | Capacitive touch channel (ESP32 / S2 / S3 only). |
| `pwm` | LEDC hardware PWM, 10 bit resolution. |

Input-only pins (GPIO34–39 on the classic ESP32) reject every output mode and
have no internal pull resistors.

### Responses (device → host)

```jsonc
{"id":12,"ok":true,"result":{"pin":2,"d":1}}
{"id":13,"ok":false,"error":{"code":"bad_mode","message":"configure the pin as an output first"}}
```

Error codes used by the firmware:

| Code | Meaning |
| --- | --- |
| `bad_json` | The line could not be parsed. |
| `bad_request` | A field is missing or out of range. |
| `bad_pin` | The GPIO does not exist or is reserved (flash / console pins). |
| `bad_mode` | The pin is not in a mode that supports the command. |
| `input_only` | The pin cannot drive a level. |
| `no_timer` | No free LEDC timer for PWM. |
| `i2c_failed` | The I²C bus could not be started on the given pins. |
| `unknown_command` | Unsupported `cmd`. |

### Events (device → host)

Events never carry an `id`.

```jsonc
{"ev":"ready","info":{ /* device info */ }}
{"ev":"sample","t":12345,"pins":{"2":{"d":1},"34":{"a":2048,"mv":1650},"4":{"t":42}}}
{"ev":"log","level":"info","message":"…"}
{"ev":"pin","pin":2,"value":1,"t":12345}
{"ev":"error","error":{"code":"bad_json","message":"…"}}
```

Sample fields, all optional and mode dependent:

| Field | Meaning |
| --- | --- |
| `d` | Digital level, `0` or `1`. |
| `a` | Raw ADC counts (`0…adcMax`, 4095 on the ESP32 family). |
| `mv` | Calibrated millivolts. |
| `t` | Raw touch reading (falls when the pad is touched on the classic ESP32). |

`t` at the top level of a `sample` event is the device uptime in milliseconds;
the host maps it onto its own clock so traces survive a reboot.

### Device info

```jsonc
{
  "protocol": 1,
  "firmware": "esp-browser-tool-diag 1.0.0",
  "chip": "ESP32-D0WD-V3",
  "cores": 2,
  "revision": 3,
  "mac": "24:6F:28:00:00:01",
  "flashSize": 4194304,
  "freeHeap": 210000,
  "pins": [0, 2, 4, 5, 12, 13, …],   // GPIOs the firmware will drive
  "maxWatch": 24,
  "adcMax": 4095
}
```

`pins` excludes everything the firmware refuses to touch: the SPI flash lines,
the UART0 console pins, and pads that are not bonded out on the package.

## Conventions

* **Timeouts** — the host rejects a command that is unanswered after 4 s. The
  handshake is retried a few times because a freshly reset board ignores input
  while the bootloader prints its banner.
* **Ordering** — responses may be interleaved with events, but never with each
  other for the same `id`.
* **Back pressure** — the firmware only streams what was asked for; lower the
  watch `interval` rather than adding pins if the link saturates.
* **Safety** — the firmware never enables Wi-Fi, never writes to NVS, and
  releases every pin it configured on `pin.reset`.
