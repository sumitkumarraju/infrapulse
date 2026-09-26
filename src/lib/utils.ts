import { type ClassValue, clsx } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

/*
 * tailwind-merge only knows Tailwind's stock scales. Our type scale lives in
 * @theme as `text-metric-lg`, `text-h2` and so on, which merge cannot tell
 * apart from a colour like `text-health-critical` — both are `text-*`. It
 * treated them as the same group and kept only the last one, so
 * `cn('text-metric-lg', 'text-health-critical')` silently dropped the size and
 * rendered a 40px KPI at body size.
 *
 * Declaring the custom names as font sizes fixes it, and keeps `cn` safe to use
 * anywhere size and colour appear together.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'h1',
            'h2',
            'h3',
            'body',
            'metric-lg',
            'metric-md',
            'metric-sm',
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
