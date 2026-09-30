# Bundled firmware

Files placed in this directory are served as `firmware/…` by the web tool and
can be installed with the **“Flash bundled firmware”** button.

No binaries are committed to this repository — build them yourself (see
[`../../firmware/README.md`](../../firmware/README.md)) and drop them here, or
point the tool at a manifest hosted elsewhere.

## Layout

```
public/firmware/
  manifest.json
  esp32/   bootloader.bin  partitions.bin  firmware.bin
  esp32s3/ bootloader.bin  partitions.bin  firmware.bin
```

## manifest.json

The format is the one used by [ESP Web Tools](https://esphome.github.io/esp-web-tools/),
so existing manifests can be reused as-is. Copy `manifest.example.json` to
`manifest.json` and adjust the parts:

```jsonc
{
  "name": "ESP Browser Tool diagnostics",
  "version": "1.0.0",
  "new_install_prompt_erase": false,
  "builds": [
    {
      "chipFamily": "ESP32",
      "parts": [
        { "path": "esp32/bootloader.bin", "offset": 4096 },
        { "path": "esp32/partitions.bin", "offset": 32768 },
        { "path": "esp32/firmware.bin", "offset": 65536 }
      ]
    }
  ]
}
```

`offset` is a decimal number of bytes: `0x1000` = 4096, `0x8000` = 32768,
`0x10000` = 65536. On ESP32-S3/C3 the bootloader lives at offset `0`.

Recognised `chipFamily` values: `ESP32`, `ESP32-S2`, `ESP32-S3`, `ESP32-C2`,
`ESP32-C3`, `ESP32-C6`, `ESP32-H2`, `ESP32-P4`, `ESP8266`. A build is used only
when the family matches exactly, so an `ESP32` build is never pushed onto an
ESP32-C6 by mistake.

Until a `manifest.json` exists, use the **“Flash locally built binaries”**
section of the tool, which reads `.bin` files straight from your disk.
