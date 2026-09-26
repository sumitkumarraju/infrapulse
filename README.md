# InfraPulse

Predictive road-condition monitoring for the network around Chandigarh
University, Gharuan. Every phone that drives a road is a sensor: bumps become a
condition score for each 50-metre segment, the score is projected 90 days
forward, and repairs are ranked by the risk they remove per rupee.

Frontend only — all data comes from a deterministic mock layer that behaves like
the real system, including a live event stream.

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

- `CLAUDE.md` — how the app is built, and what is still missing.
- `UI_DESIGN.md` — the visual specification: colour, type, the 3D map, every
  screen, motion, accessibility.
