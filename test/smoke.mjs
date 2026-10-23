/**
 * Smoke test for the browser half of dsh-balance-indicator.
 *
 * No bundler, no DOM, no real Cordis: the test evaluates `client.js` inside a
 * `node:vm` context that fakes `window.__ModuleLoader__`, then drives the plugin
 * with a fake client context. React is stubbed, so this validates the factory,
 * `apply`, the wallet mapping, formatting, the currency picker, the baseline
 * delta and every failure branch — not React rendering itself.
 *
 * Run: node test/smoke.mjs
 */
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  }
}

/**
 * React stand-in with real hook semantics: slots survive across renders, so
 * `useRef` + `useEffect` transitions can be exercised without a DOM. A render
 * pass starts at `useSyncExternalStore`, which is the component's first hook.
 */
function makeReact() {
  const slots = []
  let index = 0
  let effects = []
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children: children.flat(Infinity) }
    },
    useState(initial) {
      const slot = (slots[index++] ??= { value: typeof initial === 'function' ? initial() : initial })
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === 'function' ? next(slot.value) : next
        },
      ]
    },
    useRef(initial) {
      return (slots[index++] ??= { current: initial })
    },
    useEffect(fn) {
      effects.push(fn)
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      index = 0
      effects = []
      subscribe(() => {})
      return getSnapshot()
    },
    /** Runs the effects the last render committed, as React would after paint. */
    flushEffects() {
      const committed = effects
      effects = []
      for (const fn of committed) fn()
      return committed.length
    },
  }
}

function loadPlugin() {
  let captured = null
  const storage = memoryStorage()
  // Timers are recorded, never armed: the plugin owns a 15s cadence and a real
  // interval would keep the test process alive.
  const timers = []
  const intervals = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => (captured = entry) }, sessionStorage: storage },
    console,
    setTimeout: (fn, delay) => timers.push({ fn, delay, cancelled: false }) - 1,
    clearTimeout: (id) => {
      if (timers[id]) timers[id].cancelled = true
    },
    setInterval: (fn, delay) => intervals.push({ fn, delay, cancelled: false }) - 1,
    clearInterval: (id) => {
      if (intervals[id]) intervals[id].cancelled = true
    },
  }
  runInContext(source, createContext(sandbox))
  assert.ok(captured, 'client.js must register a module loader entry')
  assert.equal(captured.id, 'dsh-balance-indicator', 'factory id must equal the package name')

  const react = makeReact()
  const plugin = captured.factory((spec) => {
    if (spec === 'react') return react
    throw new Error(`unexpected require(${spec})`)
  })
  return { plugin, storage, react, timers, intervals }
}

function makeCtx(balance) {
  const state = { effects: [], registerOptions: null, component: null, slotKey: null, dicts: [] }
  const ctx = {
    effect(fn, label) {
      const cleanup = fn()
      state.effects.push({ label, cleanup })
    },
    slots: {
      inject(key, callback) {
        state.slotKey = key
        callback()
      },
      register(options, component) {
        state.registerOptions = options
        state.component = component
      },
    },
    locale: {
      register(namespace, dictionary) {
        state.dicts.push([namespace, dictionary])
        return () => {}
      },
      getSnapshot: () => ({ active: 'en' }),
    },
    remote: {
      account: {
        getBalance: balance,
        getState: () => accountStateImpl(),
      },
    },
  }
  return { ctx, state }
}

/** Overridable account state; scenarios flip it to exercise the link handling. */
let accountStateImpl = async () => ({
  ok: true,
  value: {
    links: {
      topUpUrl: 'https://platform.deepseek.com/top_up',
      usageUrl: 'https://platform.deepseek.com/usage',
    },
  },
})

/** Stands in for the locale seat: only the labels the assertions read are translated. */
const LABELS = {
  sessionLabel: 'Session',
  raw: 'Exact value',
  toppedUp: 'Topped-up balance',
  granted: 'Granted balance',
  toppedUpShort: 'Topped-up',
  grantedShort: 'Granted',
  refreshShort: 'Refresh',
  resetShort: 'reset',
}
const translate = (key) => LABELS[key] || key

const flush = () => new Promise((resolve) => setTimeout(resolve, 5))
const flatten = (element) => {
  if (element === null || element === undefined || typeof element !== 'object') return [element]
  return [element, ...element.children.flatMap(flatten)]
}
/**
 * Flattens the tree to text. The `+` and `·` connectors are separate elements in
 * the row and get their spacing from the flex gap, so the helper adds it back —
 * otherwise the flattened string would not read like the rendered line.
 */
const text = (element) =>
  flatten(element)
    .map((node) => {
      if (typeof node !== 'string') return ''
      return node === '+' || node === '·' ? ` ${node} ` : node
    })
    .join('')
const types = (element) => flatten(element).filter((node) => node && typeof node === 'object').map((node) => node.type)

/**
 * Reads one grid cell by key. The visual gaps between cells are CSS padding, so
 * the flattened row text runs the cells together; addressing them by key asserts
 * which value landed in which column instead of guessing at spacing.
 */
const cellText = (element, key) => {
  const cell = element.children.find((node) => node && node.props && node.props.key === key)
  return cell ? text(cell) : null
}

async function scenario(name, balance, assertions) {
  const { plugin, storage } = loadPlugin()
  const calls = []
  const wrapped = async (client) => {
    calls.push(client)
    return balance(calls.length)
  }
  const { ctx, state } = makeCtx(wrapped)
  plugin.apply(ctx)
  await flush()
  const source = state.registerOptions.inject().balanceSource
  try {
    await assertions({ plugin, state, source, calls, storage })
  } finally {
    // The plugin owns a 60s interval; without this the test never exits.
    for (const effect of state.effects) {
      if (typeof effect.cleanup === 'function') effect.cleanup()
    }
  }
  console.log(`ok  ${name}`)
}

// 1. Two wallets: picker present, both balances formatted, delta starts at zero.
await scenario(
  'the line shows the session, topped-up and granted figures',
  async () => ({
    ok: true,
    value: {
      // USD holds the most and is deliberately NOT first, so a regression to
      // "first wallet wins" fails the assertions below.
      status: 'ready',
      value: [
        { currency: 'CNY', balance: '5.5' },
        { currency: 'USD', balance: '42.15' },
      ],
      bonusWallets: [{ currency: 'CNY', balance: '3.00' }],
    },
  }),
  async ({ state, source, calls }) => {
    assert.equal(state.slotKey, 'conversation.composer.dock')
    assert.equal(state.registerOptions.id, 'balance-indicator')
    assert.equal(state.registerOptions.order, 1000, 'the row asks to sit last in the dock')
    assert.equal(state.registerOptions.name, 'conversation.composer.dock')
    assert.deepEqual(
      { ...calls[0] },
      {
        version: '0.2.0-rc.2',
        locale: 'en',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      },
    )
    assert.equal(state.dicts.length, 1)
    assert.ok(state.dicts[0][1].en && state.dicts[0][1].zh, 'both shipped locales are required')

    const snapshot = source.getSnapshot()
    assert.equal(snapshot.status, 'ready')
    assert.equal(snapshot.wallets.length, 2)
    assert.equal(snapshot.bonusWallets.length, 1)

    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)

    // Every figure sits in its own cell. Amounts get one grid column per currency,
    // so no `+` is rendered: the alignment itself is the separator.
    assert.equal(cellText(element, 'topped-label'), 'Topped-up:')
    assert.equal(cellText(element, 'granted-label'), 'Granted:')
    assert.equal(cellText(element, 'session-label'), 'Session:')
    assert.equal(cellText(element, 'topped-USD'), '$42.150')
    assert.equal(cellText(element, 'topped-CNY'), '¥5.500')
    assert.equal(cellText(element, 'granted-CNY'), '¥3.000')
    assert.equal(
      cellText(element, 'granted-USD'),
      '',
      'the granted row holds no dollars, so its dollar cell stays empty and the column keeps its place',
    )
    assert.equal(cellText(element, 'session-value'), '$0.000')
    assert.ok(!rendered.includes('—'), 'the em dash must be gone from a ready row')
    assert.equal(element.type, 'div', 'the row is inert; navigation moved to its own control')
    // The chip background is what makes the entry read as a single plugin.
    assert.ok(element.props.style.background, 'the row must carry its own chip background')
    assert.equal(
      element.props.style.borderRadius,
      '0',
      'the frame is square by request, not a rounded pill',
    )
    // The figures carry the emphasis; the labels stay muted.
    assert.equal(cellText(element, 'topped-USD').length > 0, true)

    // The grid is what puts a dollar under a dollar: one column per currency,
    // shared by both rows, in the order the topped-up row reports.
    assert.equal(element.props.style.display, 'inline-grid', 'the row must lay out as a grid')
    assert.equal(
      element.props.style.gridTemplateColumns,
      'auto auto auto auto auto auto auto',
      'two currencies means: coin, label, two amounts, session label, value, controls',
    )
    assert.equal(
      element.props.style.gridTemplateRows,
      'auto auto',
      'explicit rows are what the coin spans, so a granted row keeps its alignment',
    )
    const cellKeys = element.children.map((node) => (node && node.props ? node.props.key : node))
    assert.deepEqual(
      [...cellKeys],
      [
        'coin',
        'topped-label',
        'topped-USD',
        'topped-CNY',
        'session-label',
        'session-value',
        'reset',
        'granted-label',
        'granted-USD',
        'granted-CNY',
        'controls',
      ],
      'the currency columns must line up across both rows',
    )

    // Navigation is its own control.
    const topUp = flatten(element).find((node) => node && node.type === 'a')
    assert.ok(topUp, 'top-up button missing')
    assert.equal(topUp.props.href, 'https://platform.deepseek.com/top_up')
    assert.equal(topUp.props.target, '_blank')
    assert.equal(topUp.props.rel, 'noreferrer')
    assert.equal(topUp.props.style.borderRadius, '0', 'the buttons follow the square frame')

    // The figures are inline, so there is no disclosure control and no panel.
    assert.ok(
      !flatten(element).some((node) => node && node.props && 'aria-expanded' in node.props),
      'no disclosure control any more',
    )
    assert.ok(
      !flatten(element).some(
        (node) =>
          node && node.props && String(node.props.className || '').includes('dsh-balance-panel'),
      ),
      'no panel markup any more',
    )
    const tooltip = `${element.props.title}`
    assert.ok(
      tooltip.includes('Topped-up balance: $42.150 USD + ¥5.500 CNY'),
      `the tooltip must spell out the topped-up codes, got "${tooltip}"`,
    )
    assert.ok(
      tooltip.includes('Granted balance: ¥3.000 CNY'),
      'the tooltip must spell out the granted code',
    )

    // …and the refresh control reloads without navigating.
    const refresh = flatten(element).find(
      (node) => node && node.props && node.props.role === 'button' && text(node) === 'Refresh',
    )
    assert.ok(refresh, 'refresh control missing')
    assert.equal(refresh.props.style.borderRadius, '0', 'the refresh control is square too')
    const before = calls.length
    refresh.props.onClick({ preventDefault() {}, stopPropagation() {} })
    await flush()
    assert.ok(calls.length > before, 'the refresh control must trigger a reload')
  },
)

// 2. Single wallet: no picker.
await scenario(
  'a single wallet renders a single balance entry',
  async () => ({ ok: true, value: { status: 'ready', value: [{ currency: 'CNY', balance: '10' }], bonusWallets: [] } }),
  async ({ state, source }) => {
    const element = state.component({ balanceSource: source, t: translate })
    assert.equal(cellText(element, 'topped-CNY'), '¥10.000')
    assert.equal(cellText(element, 'granted-CNY'), null, 'no granted row without a granted wallet')
    assert.ok(!text(element).includes('Granted'), 'no granted label without a granted wallet')
    assert.ok(
      !flatten(element).some((node) => node && node.props && 'aria-expanded' in node.props),
      'no disclosure control',
    )
  },
)

// 2b2. A granted balance that rounds to zero is left out entirely.
await scenario(
  'a dust granted balance is omitted from the row',
  async () => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'USD', balance: '8.5' }],
      bonusWallets: [{ currency: 'CNY', balance: '0.0000001' }],
    },
  }),
  async ({ state, source }) => {
    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)
    assert.equal(cellText(element, 'topped-USD'), '$8.500')
    assert.ok(!rendered.includes('Granted'), 'a dust granted balance must not add a group')
    assert.ok(!rendered.includes('¥'), 'the dust currency must not appear at all')
    assert.ok(
      !`${element.props.title}`.includes('Granted balance'),
      'the tooltip must not carry a dust granted balance either',
    )
  },
)

// 2c. A topped-up balance can go negative, and the minus must survive.
await scenario(
  'a negative balance keeps its minus sign',
  async () => ({
    ok: true,
    value: { status: 'ready', value: [{ currency: 'USD', balance: '-0.01' }], bonusWallets: [] },
  }),
  async ({ state, source }) => {
    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)
    assert.equal(cellText(element, 'topped-USD'), '-$0.010', `negative balance not rendered in "${rendered}"`)
    assert.ok(`${element.props.title}`.includes('-$0.010'), 'tooltip must carry the signed value')
  },
)

// 2b. Without Platform links the row must stay inert rather than navigate nowhere.
await scenario(
  'a missing top-up link drops the button instead of navigating nowhere',
  async () => ({
    ok: true,
    value: { status: 'ready', value: [{ currency: 'USD', balance: '0.76' }], bonusWallets: [] },
  }),
  async ({ state, source }) => {
    const previous = accountStateImpl
    accountStateImpl = async () => ({ ok: true, value: { links: {} } })
    await source.refresh()
    const element = state.component({ balanceSource: source, t: translate })
    assert.equal(element.type, 'div', 'the row is never a link')
    assert.ok(
      !flatten(element).some((node) => node && node.type === 'a'),
      'no top-up button without a Platform link',
    )
    accountStateImpl = previous
  },
)

// 2d. Sub-cent remainders must not print as "-0.00", and dust bonuses stay hidden.
await scenario(
  'a sub-cent remainder renders as a clean zero',
  async () => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'USD', balance: '-0.0004' }],
      bonusWallets: [{ currency: 'USD', balance: '0.0000001' }],
    },
  }),
  async ({ state, source }) => {
    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)
    assert.equal(cellText(element, 'topped-USD'), '$0.000', `clean zero missing in "${rendered}"`)
    assert.ok(!rendered.includes('-$0.000'), 'a rounded zero must not keep a minus sign')
    assert.ok(!rendered.includes('Granted'), 'a dust granted balance must stay out of the row')
    assert.ok(
      `${element.props.title}`.includes('-0.0004 USD'),
      'the tooltip must still carry the exact value',
    )
  },
)

// 2e. Only currencies with a non-zero shown amount survive.
await scenario(
  'zero-displaying currencies stay out of the line',
  async () => ({
    ok: true,
    value: {
      status: 'ready',
      value: [
        { currency: 'CNY', balance: '-0.0004' }, // rounds to 0.000
        { currency: 'USD', balance: '-0.010' }, // rounds to -0.010
      ],
      bonusWallets: [{ currency: 'EUR', balance: '0.0000001' }], // pure dust
    },
  }),
  async ({ state, source }) => {
    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)
    // Only the currency that shows an amount survives, even though -0.0004 is
    // numerically larger than -0.010.
    assert.equal(cellText(element, 'topped-USD'), '-$0.010', `topped-up group missing in "${rendered}"`)
    assert.ok(!rendered.includes('¥'), 'a zero-displaying currency must be hidden')
    assert.ok(!rendered.includes('€'), 'a dust-only currency must be hidden')
  },
)

// 3. Delta: baseline kept across reads, later spend shows with a minus sign.
await scenario(
  'the delta is measured against the first balance of the page',
  async (call) => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: call === 1 ? '42.15' : '40.00' }],
      bonusWallets: [],
    },
  }),
  async ({ state, source }) => {
    await source.refresh()
    const snapshot = source.getSnapshot()
    assert.equal(snapshot.wallets[0].balance, '40.00')
    const element = state.component({ balanceSource: source, t: translate })
    assert.equal(
      cellText(element, 'session-value'),
      '¥2.150',
      `session figure missing in "${text(element)}"`,
    )
  },
)

// 3b. The reset control anchors the session figure at the current balance.
await scenario(
  'the reset control zeroes the session figure',
  async (call) => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: call === 1 ? '42.15' : '40.00' }],
      bonusWallets: [],
    },
  }),
  async ({ state, source }) => {
    await source.refresh()
    const element = state.component({ balanceSource: source, t: translate })
    assert.equal(cellText(element, 'session-value'), '¥2.150', 'the delta must show first')

    const reset = flatten(element).find(
      (node) => node && node.props && node.props['aria-label'] === translate('resetSession'),
    )
    assert.ok(reset, 'the reset control is missing')
    assert.equal(cellText(element, 'reset'), 'reset', 'the control is a word, not a glyph')
    reset.props.onClick({ preventDefault() {}, stopPropagation() {} })

    const after = state.component({ balanceSource: source, t: translate })
    assert.equal(cellText(after, 'session-value'), '¥0.000', 'the click must zero the figure')

    // The anchor moved, so a later read must not resurrect the old delta.
    await source.refresh()
    assert.equal(
      cellText(state.component({ balanceSource: source, t: translate }), 'session-value'),
      '¥0.000',
      'the reset must survive the next refresh',
    )
  },
)

// 4. Signed out: the host answers null.
await scenario('null from the host renders the signed-out placeholder', async () => null, async ({ state, source }) => {
  assert.equal(source.getSnapshot().status, 'signed-out')
  const rendered = text(state.component({ balanceSource: source, t: translate }))
  assert.ok(rendered.includes('—'), 'placeholder missing')
})

// 5. Remote failure: ok:false with an error.
await scenario(
  'a failed remote call surfaces the error without throwing',
  async () => ({ ok: false, error: { message: 'platform unreachable' } }),
  async ({ state, source }) => {
    const snapshot = source.getSnapshot()
    assert.equal(snapshot.status, 'failed')
    assert.equal(snapshot.error, 'platform unreachable')
    const rendered = text(state.component({ balanceSource: source, t: translate }))
    assert.ok(rendered.includes('!'), 'failure marker missing')
  },
)

// 5b. The session figure follows whichever wallet is actually being spent. The
// Platform can pay a session out of the granted wallet while the topped-up one
// stands still; an earlier version anchored the figure to the largest balance
// instead, which pinned it to a granted wallet that had no baseline — so it sat
// frozen at 0.000 for the whole session.
await scenario(
  'the session figure follows the wallet that moves',
  async (call) => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'USD', balance: '8.5' }],
      bonusWallets: [{ currency: 'CNY', balance: call === 1 ? '50' : '45' }],
    },
  }),
  async ({ state, source }) => {
    await source.refresh()
    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)
    assert.equal(cellText(element, 'session-value'), '¥5.000', `session figure missing in "${rendered}"`)
    assert.equal(cellText(element, 'topped-USD'), '$8.500', 'the topped-up group must be unchanged')
    assert.equal(cellText(element, 'granted-CNY'), '¥45.000', 'the granted group must show the new amount')
    assert.ok(
      `${element.props.title}`.includes('Granted CNY'),
      'the tooltip must name the wallet that moved',
    )
  },
)

// 5c. A wallet consumed down to nothing leaves the row but keeps driving the
// session figure: that spend is exactly what the figure is for.
await scenario(
  'an emptied granted wallet still drives the session figure',
  async (call) => ({
    ok: true,
    value: {
      status: 'ready',
      value: [{ currency: 'USD', balance: '8.5' }],
      bonusWallets: [{ currency: 'CNY', balance: call === 1 ? '50' : '0' }],
    },
  }),
  async ({ state, source }) => {
    await source.refresh()
    const element = state.component({ balanceSource: source, t: translate })
    const rendered = text(element)
    assert.equal(cellText(element, 'session-value'), '¥50.000', `session figure missing in "${rendered}"`)
    assert.ok(!rendered.includes('Granted'), 'an emptied granted wallet leaves the row')
  },
)

// 6. Thrown call: an exception is caught and reported.
await scenario(
  'a thrown remote call is reported as an error state',
  async () => {
    throw new Error('socket closed')
  },
  async ({ source }) => {
    const snapshot = source.getSnapshot()
    assert.equal(snapshot.status, 'error')
    assert.equal(snapshot.error, 'socket closed')
  },
)

// 7. Missing namespace: the plugin still activates and degrades.
{
  const { plugin } = loadPlugin()
  const { ctx, state } = makeCtx(undefined)
  ctx.remote = {}
  plugin.apply(ctx)
  await flush()
  const source = state.registerOptions.inject().balanceSource
  assert.equal(source.getSnapshot().status, 'failed')
  for (const effect of state.effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  console.log('ok  a missing remote.account namespace degrades instead of throwing')
}

// 8. Effects expose cleanup so timers cannot leak.
{
  const { plugin } = loadPlugin()
  const { ctx, state } = makeCtx(async () => null)
  plugin.apply(ctx)
  await flush()
  assert.equal(state.effects.length, 2, 'expected the locale and refresh effects')
  for (const effect of state.effects) assert.equal(typeof effect.cleanup, 'function', `${effect.label} has no cleanup`)
  for (const effect of state.effects) effect.cleanup()
  console.log('ok  every effect returns a cleanup function')
}

// 9. The cadence is a plain 15s timer, independent of turn lifecycle.
{
  const { plugin, react, timers, intervals } = loadPlugin()
  const { ctx, state } = makeCtx(async () => ({
    ok: true,
    value: { status: 'ready', value: [{ currency: 'USD', balance: '0.76' }], bonusWallets: [] },
  }))
  plugin.apply(ctx)
  await flush()
  assert.equal(intervals.length, 1, 'the cadence must be a single interval')
  assert.equal(intervals[0].delay, 15000, 'the cadence must be 15 seconds')

  // A session that settles schedules nothing: refreshes must not depend on turn
  // lifecycle, because a turn can run for minutes.
  const source = state.registerOptions.inject().balanceSource
  timers.length = 0
  state.component({
    balanceSource: source,
    t: translate,
    sessionId: 'session-1',
    useSessionStatus: (selector) => selector(new Map([['session-1', { running: false }]])),
  })
  react.flushEffects()
  assert.equal(timers.length, 0, 'a settled turn must not schedule reads')

  for (const effect of state.effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  assert.equal(intervals[0].cancelled, true, 'unmounting must clear the cadence')
  console.log('ok  the balance refreshes on a plain 15s cadence')
}

// 10. A still-pending read must absorb overlapping ticks instead of stacking.
{
  const { plugin } = loadPlugin()
  const calls = []
  const { ctx, state } = makeCtx(() => {
    calls.push(1)
    return new Promise(() => {}) // never settles: the read stays in flight
  })
  plugin.apply(ctx)
  await flush()
  const source = state.registerOptions.inject().balanceSource
  await source.refresh()
  await source.refresh()
  assert.equal(calls.length, 1, 'a pending read must absorb overlapping ticks')
  for (const effect of state.effects) {
    if (typeof effect.cleanup === 'function') effect.cleanup()
  }
  console.log('ok  an in-flight read absorbs overlapping refreshes')
}

console.log('\nall smoke checks passed')
process.exit(0)
