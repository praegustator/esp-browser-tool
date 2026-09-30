# Diagnostic firmware

`esp32-diag/esp32-diag.ino` is the small firmware the browser tool talks to. It
exposes every usable GPIO over the JSON protocol described in
[`../docs/PROTOCOL.md`](../docs/PROTOCOL.md): read levels and voltages, drive
outputs, PWM, blink, read touch pads, and scan an I²C bus.

It deliberately does **not** use Wi-Fi, Bluetooth or NVS, so flashing it is a
reversible, low-risk step before you move on to ESPHome or your own firmware.

## Requirements

* [Arduino-ESP32 core 3.x](https://github.com/espressif/arduino-esp32) (ESP-IDF 5.x)
* [ArduinoJson 7.x](https://arduinojson.org/)

Supported targets: ESP32, ESP32-S2, ESP32-S3, ESP32-C3. Other RISC-V variants
build too but without touch support.

## Build with arduino-cli

```bash
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli lib install "ArduinoJson"

# Classic ESP32 dev board
arduino-cli compile --fqbn esp32:esp32:esp32 firmware/esp32-diag --output-dir build/esp32

# ESP32-S3 / ESP32-C3
arduino-cli compile --fqbn esp32:esp32:esp32s3 firmware/esp32-diag --output-dir build/esp32s3
arduino-cli compile --fqbn esp32:esp32:esp32c3 firmware/esp32-diag --output-dir build/esp32c3
```

The output directory then contains `esp32-diag.ino.bootloader.bin`,
`esp32-diag.ino.partitions.bin` and `esp32-diag.ino.bin`.

## Build with PlatformIO

```bash
pio run -e esp32dev          # or -e esp32s3, -e esp32c3
```

`platformio.ini` in this directory already pins the required libraries.

## Flashing

Easiest: open the web tool, expand **“Flash locally built binaries”** and select
the `.bin` files. Offsets are taken from the file name when present
(`0x1000-bootloader.bin`), otherwise a single file is written at `0x10000`.

With `esptool.py`:

```bash
esptool.py --chip esp32 --baud 921600 write_flash \
  0x1000  build/esp32/esp32-diag.ino.bootloader.bin \
  0x8000  build/esp32/esp32-diag.ino.partitions.bin \
  0x10000 build/esp32/esp32-diag.ino.bin
```

Bootloader offsets differ per target: `0x1000` on the classic ESP32 and S2,
`0x0` on the S3 and the RISC-V parts.

## Publishing a bundled build

To let users press **“Flash bundled firmware”**, drop the binaries into
`public/firmware/` and describe them in `public/firmware/manifest.json` — see
[`../public/firmware/README.md`](../public/firmware/README.md).

## Hardware notes

* Never apply more than **3.3 V** to a GPIO, and always share ground with
  whatever you probe. The ESP32 is **not** 5 V tolerant.
* Keep a series resistor (220 Ω – 1 kΩ) between a GPIO and an LED.
* The firmware hides the SPI flash pins (GPIO6–11 on the classic ESP32) and the
  UART0 console pins, because driving them crashes or bricks the boot.
* Strapping pins (GPIO0, 2, 5, 12, 15 on the classic ESP32) are exposed but
  flagged in the UI: holding them at the wrong level during a reset changes how
  the chip boots.
* On the classic ESP32, ADC2 pins (GPIO0, 2, 4, 12–15, 25–27) are unavailable
  while Wi-Fi is active. This firmware keeps Wi-Fi off, so they work — but the
  same pins will misbehave under ESPHome.
