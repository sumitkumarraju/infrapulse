import { GlassPanel } from '@/components/glass/GlassPanel'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  BAND_COLOR,
  BAND_LABEL,
  greyscale,
  scoreBand,
  scoreColor,
} from '@/lib/health'

const BASE = [
  ['void', '#060B18'],
  ['base', '#0A1022'],
  ['surface-1', '#0F172E'],
  ['surface-2', '#16203C'],
  ['surface-3', '#1E2B4D'],
] as const

const ACCENT = [
  ['accent', '#22D3EE'],
  ['accent-bright', '#67E8F9'],
  ['accent-deep', '#0E7490'],
] as const

const TEXT = [
  ['text-1', '#E8EDF7', '14.6:1'],
  ['text-2', '#97A3BD', '7.2:1'],
  ['text-3', '#5F6E8C', '3.5:1 — large text only'],
] as const

const TYPE = [
  ['display', 'text-display', 'Predict before it breaks.'],
  ['h1', 'text-h1', 'Command Center'],
  ['h2', 'text-h2', 'Kharar–Gharuan Road'],
  ['h3', 'text-h3', 'Why this score'],
  ['body', 'text-body', 'Roughness has risen sharply since the monsoon.'],
  ['sm', 'text-sm', 'Estimated cost, patching'],
] as const

function Section({
  title,
  note,
  children,
}: {
  title: string
  note?: string
  children: React.ReactNode
}) {
  return (
    <section className="border-hairline flex flex-col gap-4 border-t pt-8">
      <div className="flex flex-col gap-1">
        <h2 className="text-h2">{title}</h2>
        {note && <p className="text-text-2 max-w-xl text-sm">{note}</p>}
      </div>
      {children}
    </section>
  )
}

function Swatch({ name, hex }: { name: string; hex: string }) {
  return (
    <div className="flex min-w-36 flex-col gap-2">
      <div
        className="rounded-card border-hairline h-16 border"
        style={{ background: hex }}
      />
      <div className="flex flex-col">
        <span className="text-sm">{name}</span>
        <span className="metric text-metric-sm text-text-2">{hex}</span>
      </div>
    </div>
  )
}

export function Styleguide() {
  // The ramp must still rank the bands in greyscale (UI_DESIGN 1.4).
  const rampScores = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12 px-6 py-12">
      <header className="flex flex-col gap-3">
        <span className="eyebrow">Phase 0 · foundation</span>
        <h1 className="text-h1">InfraPulse styleguide</h1>
        <p className="text-body text-text-2 max-w-2xl">
          Every token in this page comes from{' '}
          <code className="text-text-1">src/design/tokens.css</code>, generated
          from <code className="text-text-1">UI_DESIGN.md</code>. If a screen
          needs a value that is not here, the design document changes first.
        </p>
      </header>

      <Section
        title="Base and surfaces"
        note="Three elevation levels, not a continuum: flat, raised, floating glass."
      >
        <div className="flex flex-wrap gap-4">
          {BASE.map(([name, hex]) => (
            <Swatch key={name} name={name} hex={hex} />
          ))}
        </div>
      </Section>

      <Section
        title="Accent — cyan"
        note="The interface's own colour: selection, focus, live telemetry. It never means healthy."
      >
        <div className="flex flex-wrap gap-4">
          {ACCENT.map(([name, hex]) => (
            <Swatch key={name} name={name} hex={hex} />
          ))}
        </div>
      </Section>

      <Section title="Text" note="text-3 is banned from body copy.">
        <div className="flex flex-col gap-2">
          {TEXT.map(([name, hex, contrast]) => (
            <div key={name} className="flex items-baseline gap-4">
              <span className="text-body w-72" style={{ color: hex }}>
                The roughest 100 metres on this route.
              </span>
              <span className="metric text-metric-sm text-text-2">{name}</span>
              <span className="text-text-2 text-sm">{contrast}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section
        title="Road health"
        note="The only semantic ramp. Never used for buttons, links or generic success and error states."
      >
        <div className="flex flex-wrap gap-4">
          {(['good', 'watch', 'critical'] as const).map((band) => (
            <div key={band} className="flex min-w-44 flex-col gap-2">
              <div
                className="rounded-card h-16"
                style={{ background: BAND_COLOR[band] }}
              />
              <span className="text-sm">{BAND_LABEL[band]}</span>
              <span className="metric text-metric-sm text-text-2">
                {BAND_COLOR[band]}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-col gap-3">
          <span className="eyebrow">Continuous ramp, mixed in Oklab</span>
          <div className="rounded-card border-hairline flex overflow-hidden border">
            {rampScores.map((s) => (
              <div key={s} className="flex-1">
                <div className="h-12" style={{ background: scoreColor(s) }} />
                <div
                  className="h-6"
                  style={{ background: greyscale(scoreColor(s)) }}
                />
                <div className="metric bg-surface-1 text-metric-sm text-text-2 py-1 text-center">
                  {s}
                </div>
              </div>
            ))}
          </div>
          <p className="text-text-2 max-w-2xl text-sm">
            The greyscale strip is the colour-blindness check. It climbs the
            whole way, so no two scores share a grey — which is why the good end
            is emerald rather than a deeper green. The watch/good boundary is
            thin, so stroke width, tower height and the{' '}
            <code className="text-text-1">!</code> glyph carry the ranking, not
            hue.
          </p>
        </div>
      </Section>

      <Section
        title="Typography"
        note="Inter for text, JetBrains Mono for every number a person compares. Never more than three sizes in one panel."
      >
        <div className="flex flex-col gap-4">
          {TYPE.map(([name, cls, sample]) => (
            <div key={name} className="flex items-baseline gap-6">
              <span className="metric text-metric-sm text-text-2 w-20 shrink-0">
                {name}
              </span>
              <span className={cls}>{sample}</span>
            </div>
          ))}
          <div className="flex items-baseline gap-6">
            <span className="metric text-metric-sm text-text-2 w-20 shrink-0">
              metric-lg
            </span>
            <span className="metric text-metric-lg">₹ 1,42,80,000</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="eyebrow">Signature pairing</span>
            <span className="metric text-metric-lg">31</span>
            <span className="text-text-2 text-sm">
              label above, monospace value below
            </span>
          </div>
        </div>
      </Section>

      <Section
        title="Buttons"
        note="Minimum 44px touch target on desktop overlays."
      >
        <div className="flex flex-wrap items-center gap-3">
          <Button>Enter Command Center</Button>
          <Button variant="secondary">Add to budget plan</Button>
          <Button variant="outline">Create work order</Button>
          <Button variant="ghost">Mark inspected</Button>
          <Button variant="destructive">Reopen</Button>
          <Button disabled>Disabled</Button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button size="sm">Small</Button>
          <Button size="md">Medium</Button>
          <Button size="lg">Large</Button>
        </div>
      </Section>

      <Section title="Badges">
        <div className="flex flex-wrap items-center gap-3">
          <Badge>Arterial</Badge>
          <Badge tone="accent">Live</Badge>
          <Badge tone="good">{BAND_LABEL[scoreBand(82)]}</Badge>
          <Badge tone="watch">{BAND_LABEL[scoreBand(55)]}</Badge>
          <Badge tone="critical">! {BAND_LABEL[scoreBand(31)]}</Badge>
          <Badge mono>SEG-0214</Badge>
        </div>
      </Section>

      <Section
        title="Glass"
        note="Only four surfaces are glass: the KPI bar, the map rails, the segment drawer and the mobile bottom sheet. Glass never sits on glass."
      >
        <div className="rounded-card border-hairline relative overflow-hidden border">
          {/* Stand-in for the map, so the frost has something to blur. */}
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background:
                'radial-gradient(circle at 25% 30%, #0E7490 0%, transparent 45%), radial-gradient(circle at 70% 70%, #B4123C 0%, transparent 40%), #0A1022',
            }}
          />
          <div className="relative flex flex-wrap gap-6 p-10">
            <GlassPanel className="flex min-w-72 flex-col gap-3 p-6" static>
              <span className="eyebrow">City health index</span>
              <span className="metric text-metric-lg">68.4</span>
              <p className="text-text-2 text-sm">
                Down 4.1 points since the monsoon began.
              </p>
            </GlassPanel>

            <GlassPanel className="flex min-w-72 flex-col gap-4 p-6" static>
              <span className="eyebrow">Fix these first</span>
              {[
                ['01', 'SEG-0214', 31],
                ['02', 'SEG-0088', 36],
                ['03', 'SEG-0451', 44],
              ].map(([rank, id, score]) => (
                <div key={id as string} className="flex items-center gap-3">
                  <span className="metric text-metric-sm text-text-3">
                    {rank}
                  </span>
                  <span className="metric text-metric-sm flex-1">{id}</span>
                  <Badge tone={scoreBand(score as number)}>
                    {score as number}
                  </Badge>
                </div>
              ))}
            </GlassPanel>
          </div>
        </div>
      </Section>

      <Section
        title="Shape and elevation"
        note="Radii: 4 chips, 8 controls, 12 cards, 20 glass, 999 pills. Nothing else."
      >
        <div className="flex flex-wrap gap-4">
          <div className="rounded-chip border-hairline bg-surface-1 flex size-24 items-center justify-center border text-sm">
            4
          </div>
          <div className="rounded-control border-hairline bg-surface-1 flex size-24 items-center justify-center border text-sm">
            8
          </div>
          <div className="rounded-card bg-surface-1 shadow-raised flex size-24 items-center justify-center text-sm">
            12 raised
          </div>
          <div className="rounded-glass border-hairline-strong bg-surface-2 flex size-24 items-center justify-center border text-sm">
            20
          </div>
          <div className="border-hairline bg-surface-1 flex h-24 items-center justify-center rounded-full border px-8 text-sm">
            999
          </div>
        </div>
      </Section>
    </div>
  )
}
