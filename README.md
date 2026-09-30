# ESP Browser Tool

**A friendly ESP32 lab bench that lives in a Chrome tab.**

Plug an ESP32 into USB, flash a small diagnostic firmware from the browser, and
then watch and drive every GPIO live: see which pins are high or low, plot the
voltage curve of an ADC pin, blink an LED, sweep a PWM duty cycle, feel out a
capacitive touch pad, or scan an I²C bus — all before you commit to ESPHome or
a project firmware.

It is the "what is this pin actually doing?" tool: hold a 3.3 V jumper against
an unlabelled header pin and watch its tile flip to **HIGH** in real time.

```
┌──────────────┐   Web Serial    ┌────────────────────┐
│  Chrome tab  │ ◀─────────────▶ │  ESP32 + diag OS   │
│  (this app)  │   JSON lines    │  (firmware/)       │
└──────────────┘                 └────────────────────┘
```

## Features

* **One-click firmware install** — `esptool-js` runs in the browser, so no
  Python, no drivers beyond the USB-UART one, no toolchain.
* **Live pin matrix** — one tile per usable GPIO with its mode, its current
  value, and a rolling mini-oscilloscope of the last few seconds.
* **Real control** — push-pull / open-drain outputs, HIGH / LOW / toggle /
  timed pulse, software blink, and hardware PWM with a duty slider.
* **Measurements** — digital levels, calibrated millivolts on ADC pins, raw
  capacitive touch readings, edge counts, estimated frequency and duty cycle.
* **Guard rails** — SPI-flash and console pins are hidden, input-only pins
  refuse output modes, and strapping pins carry a warning explaining what
  happens if you hold them at the wrong level during a reset.
* **I²C scanner** — probe a bus on any pin pair and list the addresses that
  answer.
* **Demo board** — a fully simulated ESP32 lets you explore the whole UI (and
  run the test-suite) without any hardware.
* **Console** — every command, response and firmware log line, timestamped.

## Requirements

* Desktop **Chrome, Edge or Opera 89+** (the Web Serial API is not available in
  Firefox, Safari, or on mobile).
* The page must be served over **HTTPS** or from **localhost**.
* An ESP32, ESP32-S2, ESP32-S3 or ESP32-C3 board with a USB-serial interface.

## Quick start

```bash
npm install
npm run dev       # http://localhost:5173
```

1. **Try the demo board** — press *Try demo board* to explore the interface
   with a simulated ESP32. Nothing is flashed, nothing is connected.
2. **Install the firmware** — build it (see
   [`firmware/README.md`](firmware/README.md)) and flash it from the *Install
   firmware* panel, either from a bundled manifest or straight from the `.bin`
   files on your disk. This is a one-off step per board.
3. **Connect** — press *Connect board* and pick the serial port.
4. **Probe** — give a pin a mode and tick **Watch**:
   * *Input ↑ pull-up* — the pin reads **HIGH**; touch it to GND and it drops.
     The fastest way to identify an unknown header pin.
   * *Analog (ADC)* — feed 0–3.3 V in and watch the curve, with live min/max
     in volts.
   * *Output* — wire an LED through a 220 Ω resistor and use HIGH / LOW /
     Blink to confirm it is the pin you think it is.
   * *PWM* — drag the duty slider to dim that LED.
   * *Touch* — put a finger on the pad and watch the reading collapse.
5. **Release all pins** before unplugging, then move on to ESPHome Builder or
   your own firmware with a pin map you have actually verified.

### Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with hot reload. |
| `npm run build` | Type-check and produce a static bundle in `dist/`. |
| `npm run preview` | Serve the production build locally. |
| `npm test` | Run the Vitest suite. |
| `npm run typecheck` | TypeScript only, no bundle. |

The build output is a plain static site: `dist/` can be dropped on GitHub Pages
or any static host (HTTPS is required for Web Serial).

## Safety

The ESP32 is a **3.3 V** part and is **not** 5 V tolerant.

* Never feed more than 3.3 V into a GPIO, and never source more than ~12 mA
  from one.
* Always connect the grounds of the board and whatever you probe.
* Put a resistor in series with every LED.
* Respect the ⚠ warnings on strapping pins — holding GPIO0 low during a reset
  drops the chip into the bootloader instead of your firmware.

## How it works

| Layer | Where | Role |
| --- | --- | --- |
| Protocol | `src/protocol/` | Types, encoder, tolerant decoder and request validation for the JSON-line protocol. |
| Transport | `src/transport/` | Web Serial port handling with UTF-8 safe line framing, plus a fully simulated board. |
| Device | `src/device/` | Request/response correlation with timeouts, pin state and trace store, board pin catalogues, and the UI-agnostic controller. |
| Flashing | `src/flash/` | ESP Web Tools compatible manifests and an `esptool-js` driver. |
| UI | `src/ui/` | Toolbar, pin tiles, canvas scopes, flashing panel and console — plain DOM, no framework. |
| Firmware | `firmware/` | The Arduino sketch that runs on the board. |

The wire protocol is documented in [`docs/PROTOCOL.md`](docs/PROTOCOL.md). It is
small enough to drive from any other client — a terminal and
`{"id":1,"cmd":"hello","protocol":1}` are enough.

The simulated board in `src/transport/simulatedBoard.ts` implements the same
protocol as the firmware, which makes it both the demo mode and the reference
the test-suite runs against.

## License

MIT
