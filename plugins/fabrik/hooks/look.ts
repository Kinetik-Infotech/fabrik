import type { Register, ThemeSetArgs } from 'claude-code'

import { makeColors } from './make-colors.js'

// fabrik.tech's colours, from site/styles.css: cream by day, navy by night, amber throughout.
export const definition = {
  label: 'fabrik',
  roles: { accent: '#E3A82B', danger: '#B3392F', success: '#3F7D4E', warning: '#C2621B', pro: '#3E5A8C' },
  light: {
    gray: {
      anchors: {
        'surface-0': '#F6F1E7',
        'surface-1': '#FBF8F2',
        'surface-2': '#FFFFFF',
        'text-primary': '#1B2433',
        'text-secondary': '#2E3B52',
        'text-muted': '#545F70',
      },
    },
  },
  dark: {
    gray: {
      anchors: {
        'surface-0': '#111827',
        'surface-1': '#1A2333',
        'surface-2': '#1F2A3D',
        'surface-3': '#243045',
        'text-primary': '#F6F1E7',
        'text-secondary': '#D9DEE6',
        'text-muted': '#B9C1CD',
      },
    },
  },
}

const { theme } = makeColors(definition)

const LOOK: ThemeSetArgs = { colors: theme }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const set = await $.theme.set(LOOK)

    if (!set.isDrawn && (await $.session.surfaces()).some(s => s === 'desktop' || s === 'mobile')) {
      $.ui.status(set.reason)
    }

    return next(e)
  })
}
