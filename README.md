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

A web-based, hardware-free proof of concept for the first machine: a **remote wrecking-ball crane** demolishing high-rises.

| Path | What it is |
|---|---|
| `game/` | First-person demolition game seen from the cab of a crawler crane, built with Three.js and the Rapier physics engine. A 14-tonne wrecking ball hangs from a 34 m lattice boom on a simulated cable: it swings as a real pendulum, so the operator has to time swings, use the drag line to wind up, and steady the sway. High-rises are built from individual wall panels and floor slabs. A hard hit cracks the panels it touches, and whatever they were holding up collapses under real physics. Every lot is different: each round draws **1 to 3 buildings from 9 templates** (slab block, point tower, wedding-cake tower, podium tower, glass office, twin towers, brick tenement, parking garage, L-shaped apartments) and places them at random around the crane, next to a protected heritage house. The boom stops on contact instead of bulldozing (a "boom strike" costs points). Hits give feedback through camera shake, dust, synthesized audio, and gamepad or phone vibration. Includes star ratings, a leaderboard, and adjustable **simulated network latency**. Add `?lot=0,4` to the URL to pick specific templates for a demo. |
| `pad/` | **Phone as remote controller.** Scan the QR code on the game screen and the phone becomes a twin-joystick crane controller that sends input over WebSocket at 30 Hz. If no signal arrives for 400 ms, the sticks release automatically, a dead-man switch as on real remote machinery. |
| `dashboard/` | Live telemetry dashboard over Server-Sent Events. It shows command vs. actual joint motion, the input delay caused by latency, cable tension, a top-down map of the lot with the ball's path, an event stream, and the leaderboard. Each session can be exported as JSON or CSV. |
| `waitlist/` | Waitlist sign-up page (email, name, birthday). Admin export is protected by a token. |
| `server.js` | Lightweight Node.js server that serves the static files and provides the telemetry API, the live event stream, the WebSocket controller relay, and QR codes. |

### Controls
- **Left stick:** `A` / `D` swing the upper body · `W` / `S` lower or hoist the ball
- **Right stick:** `I` / `K` boom down or up · `J` pull the drag line (release to throw the ball) · `L` steady the sway
- **Tracks:** arrow keys · `V` toggles third-person view (debug) · `[` `]` adjust latency · right-drag to look around
- Bring every yellow-ringed building down (60% of its pieces displaced), then press `Enter` to finish the job.
- Xbox and PlayStation gamepads and the phone controller are also supported.

The game's controls follow real crane conventions, so skills learned in the game carry over to the real machine. That is the basis of the player-to-operator pipeline.

### Telemetry schema (20 Hz per session)
| Field | Meaning |
|---|---|
| `t`, `src`, `latencyMs` | Time, input source (keyboard, gamepad, or phone), simulated latency |
| `inSwing` `inBoom` `inHoist` `inDrag` `inTrackL` `inTrackR` | Raw operator input (−1 to 1) |
| `dSwing` `dBoom` `dHoist` `dDrag` | Input as delivered to the machine after latency |
| `swing` `boom` `hoist` | Actual slew angle (°), boom elevation (°), cable length (m) |
| `tgtSwing` `tgtBoom` `tgtHoist` | The same with no latency and no drive lag |
| `tipX` `tipY` `tipZ` | Boom tip position |
| `ballX` `ballY` `ballZ`, `ballVX` `ballVY` `ballVZ` | Wrecking ball position and velocity |
| `baseX` `baseZ` `heading` | Crawler pose |
| `tensionKN`, `load`, `impulse` | Cable tension (kN and 0 to 1), peak ball contact force (kN) |

Events are logged too: the lot layout (buildings, positions, piece counts), heavy impacts, demolition progress, buildings brought down, boom strikes, collateral damage to the heritage house, latency changes, and controller connects and disconnects.

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
- [ ] Excavator and long-reach demolition machines for clearing the rubble
- [ ] Café operator station: physical joysticks, seat motion, VR mode
- [ ] Latency compensation research (predictive display, input shaping)
- [ ] First remote session on a real machine at a partner site
- [ ] Sea and air modules: tugboat docking, drone inspection
- [ ] Operator certification track and data-licensing pilot
