# physical-ai-data

**Play real machines. Generate the data that teaches robots to work.**

Physical AI is starved of one thing: real-world teleoperation data from humans doing real physical work. Collecting it today means paying operators by the hour to drive expensive machines in controlled conditions. We flip that model. People **pay us** to operate heavy machinery, vessels, and aircraft for fun, first in simulation and then remotely on real hardware. Every stick movement, every collision, and every success or failure becomes structured training data for autonomous machines.

**Live demo:** [Game](https://physical-ai-data.senseharbor.dev/game/) · [Telemetry dashboard](https://physical-ai-data.senseharbor.dev/dashboard/) · [Join the waitlist](https://physical-ai-data.senseharbor.dev/waitlist/)

---

## Business model

### 1. Café entertainment: the on-site experience
A café or arcade where customers sit in a realistic operator seat, with ISO-pattern joysticks, motion and haptics, or VR, and take on missions: demolish a building, load a truck, dock a ship, land a helicopter.

- **Revenue:** pay-per-session, memberships, birthday and team-building packages, corporate events, and leaderboard tournaments.
- **Data:** high-quality, fully instrumented sessions, recorded in a controlled environment on known hardware.

### 2. Remote entertainment: operate real machines from anywhere
Players at home or in our cafés control **real machines at real sites over the network**. Example missions: dig at a demolition yard, drive a forklift in a warehouse, pilot a boat in a test harbor, fly a drone over a farm. Latency compensation, safety interlocks (dead-man switches and geofencing), and human supervisors make it safe.

- **Revenue:** premium "real machine" sessions, sponsored experiences, and tourism tie-ins.
- **Data:** genuine real-world teleoperation data covering real physics, real sensor noise, and real latency, which is exactly what physical AI models lack.

### 3. Land, sea, and air: one platform, many machines
The same platform (operator station, telemetry pipeline, scoring, and data schema) works for any machine a human controls with sticks and pedals:

| Domain | Simulations and remote experiences | Data value for autonomy |
|---|---|---|
| **Land** | Excavators, bulldozers, cranes, forklifts, mining trucks, agricultural tractors | Construction, logistics, and agriculture automation |
| **Sea** | Tugboats, container port cranes, ROV submarines, ship docking | Autonomous vessels and port automation |
| **Air** | Drones, helicopters, aerial work platforms, cargo eVTOL | Autonomous flight, inspection, and delivery |

Each new machine type is a new game catalog for players and a new dataset for buyers.

### 4. From players to pros: the workforce pipeline
The best players are screened, trained, and licensed to become **professional remote operators**, who work real job sites in other cities or countries from a safe office. This addresses labor shortages in dangerous industries, and the operators keep generating expert-level data.

### 5. The data flywheel
```
Players pay to play ──▶ Sessions generate labeled teleoperation data
        ▲                                   │
        │                                   ▼
Better games and more machines ◀── Data sold and licensed to physical-AI and OEM teams,
                                      and used to train our own autonomous operators
```

Revenue streams: **entertainment** (B2C), **data licensing** (B2B: robotics, OEMs, autonomy startups), **remote-operator services** (B2B: construction, ports, logistics), and **venue franchising**.

---

## What this demo shows

A web-based, hardware-free proof of concept: **three remote heavy machines and two kinds of missions** on one platform. Pick a machine on the start screen (or press `1` to `3`, or tap *Machine ⇄* on the phone); each one has its own joints, physics, and data fields, but the same controls, telemetry pipeline, and dashboard.

| Machine | Mission | What makes it hard |
|---|---|---|
| 🏗️ Wrecking-ball crane | Demolition | A 14 t ball on a 34 m boom swings as a real pendulum: time the swings, wind up with the drag line, steady the sway |
| 🦾 High-reach demolition excavator | Demolition | A 23 m front with a concrete crusher: bite the walls floor by floor; whatever the crusher pushes into cracks |
| 🚜 20 t hydraulic excavator | Excavation | Dig a spoil heap of loose soil and load 1 or 2 dump trucks to the line, with little spillage and without touching the live gas line |

| Path | What it is |
|---|---|
| `game/` | First-person game seen from the machine's cab, built with Three.js and the Rapier physics engine. **Demolition:** high-rises are built from individual wall panels and floor slabs; a hard hit (ball) or a hard push (crusher) cracks the panels it touches, and whatever they were holding up collapses under real physics. Pieces **shatter** into rough concrete chunks (each its own rigid body) where the ball strikes, when the crusher bites loose slabs, and when they fall from an upper floor and slam into the ground. Every lot is different: each round draws **1 to 3 buildings from 9 templates** (slab block, point tower, wedding-cake tower, podium tower, glass office, twin towers, brick tenement, parking garage, L-shaped apartments; the high-reach machine gets the ones up to 8 floors) next to a protected heritage house. **Excavation:** the spoil heap is a few hundred loose soil clods; the bucket scoops them, carries them, and dumps them into the truck beds. Heap size, truck count, and positions change every round. On every machine the boom and arm stop on contact instead of slicing through buildings, trucks, or the gas line (a strike costs points), and the bucket can't dig through the ground. Hits give feedback through camera shake, dust, synthesized audio, and gamepad or phone vibration. Includes star ratings, a leaderboard, and adjustable **simulated network latency**. URL options: `?machine=crane|highreach|excavator`, and `?lot=0,4` to pick demolition templates for a demo. |
| `pad/` | **Phone as remote controller.** Scan the QR code on the game screen and the phone becomes a twin-joystick controller for whichever machine is selected (the stick labels follow the machine) that sends input over WebSocket at 30 Hz. If no signal arrives for 400 ms, the sticks release automatically, a dead-man switch as on real remote machinery. |
| `dashboard/` | Live telemetry dashboard over Server-Sent Events. It shows command vs. actual joint motion for each of the machine's joints, the input delay caused by latency, cable tension or hydraulic load, a top-down map of the site with the tool's path, an event stream, and the leaderboard. Each session can be exported as JSON or CSV. |
| `waitlist/` | Waitlist sign-up page (email, name, birthday). Admin export is protected by a token. |
| `server.js` | Lightweight Node.js server that serves the static files and provides the telemetry API, the live event stream, the WebSocket controller relay, and QR codes. |

### Controls
All machines use the same two sticks; what each axis does depends on the machine, following real ISO conventions.

| | Wrecking-ball crane | High-reach excavator | Excavator |
|---|---|---|---|
| Left stick ←→ (`A` `D`) | Swing | Swing | Swing |
| Left stick ↑↓ (`W` `S`) | Lower / hoist the ball | Arm out / in | Arm out / in |
| Right stick ↑↓ (`I` `K`) | Boom down / up | Boom down / up | Boom down / up |
| Right stick ←→ (`J` `L`) | Drag line in / steady the sway | Crusher curl / out | Bucket curl / dump |

- **Tracks:** arrow keys · `V` toggles third-person view (debug) · `[` `]` adjust latency · right-drag to look around · `1` `2` `3` pick a machine on the start screen
- Finish the job (every yellow-ringed building down to 60%, or every truck loaded to the line), then press `Enter`.
- Xbox and PlayStation gamepads and the phone controller are also supported.

The game's controls follow real crane conventions, so skills learned in the game carry over to the real machine. That is the basis of the player-to-operator pipeline.

### Telemetry schema (20 Hz per session)
Every sample carries the common fields plus the joints of the machine that was driven (`machine` says which). CSV exports use one fixed set of columns for all machines; columns a machine doesn't have stay empty.

| Field | Meaning |
|---|---|
| `t`, `machine`, `src`, `latencyMs` | Time, machine id, input source (keyboard, gamepad, or phone), simulated latency |
| `inLX` `inLY` `inRX` `inRY` `inTrackL` `inTrackR` | Raw stick and track input (−1 to 1) |
| `in<Joint>`, `d<Joint>` | Command for each joint, as given and as delivered after latency (crane: Swing, Boom, Hoist, Drag; excavators: Swing, Boom, Arm, Bucket or Tool) |
| `<joint>`, `tgt<Joint>` | Actual joint value and the same with no latency and no drive lag (angles in °, cable in m) |
| `tipX` `tipY` `tipZ`, `toolX` `toolY` `toolZ` | Boom tip; working point (wrecking ball, bucket teeth, or crusher jaws) |
| `ballVX` `ballVY` `ballVZ`, `tensionKN` | Crane only: ball velocity, cable tension |
| `payloadKg`, `toolSpeed` | Excavators: soil in the bucket, tool speed |
| `baseX` `baseZ` `heading` | Crawler pose |
| `load`, `impulse` | Cable tension or hydraulic load (0 to 1), peak tool contact force (kN) |

Events are logged too: the machine and its joints, the site layout (buildings, heap, trucks, gas line), heavy impacts, progress, buildings brought down, trucks loaded, spillage, boom and gas-line strikes, collateral damage to the heritage house, latency changes, and controller connects and disconnects.

---

## Run locally

```bash
npm install
PORT=8411 DATA_DIR=/tmp/excavator-data node server.js
# open http://localhost:8411/game/
```

Optional: set `WAITLIST_ADMIN_TOKEN` to enable waitlist export (`GET /api/waitlist/export.csv` with `Authorization: Bearer <token>`).

## Roadmap
- [x] Wrecking-ball crane simulation with physics, procedural high-rise lots, telemetry, and a phone controller
- [x] High-reach demolition excavator and an excavation mission (dig and load trucks) on the same platform
- [ ] More missions: trenching, clearing the rubble, loading with a wheel loader
- [ ] Café operator station: physical joysticks, seat motion, VR mode
- [ ] Latency compensation research (predictive display, input shaping)
- [ ] First remote session on a real machine at a partner site
- [ ] Sea and air modules: tugboat docking, drone inspection
- [ ] Operator certification track and data-licensing pilot
