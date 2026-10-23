/**
 * Browser half of `dsh-balance-indicator`.
 *
 * Registers one ambient entry into the `conversation.composer.dock` list slot,
 * directly beside the built-in `stats` pills (token usage and cache hit).
 *
 * The line carries every figure inline — session spend first, then the two
 * balances the account holds:
 *
 *     💰 Session: ¥1.910 · Topped-up: $8.505 + -¥0.189 · Granted: ¥50.230 ↻ [Top up]
 *
 * `Topped-up` is always present (`normal_wallets`); `Granted` appears only when
 * the account actually holds a granted balance (`bonus_wallets`). Amounts are
 * symbol-first with FRACTION_DIGITS decimals, currencies whose shown amount
 * rounds to zero are dropped, and the tooltip spells the currency codes out.
 *
 * Clicking the top-up button opens the Platform page; `↻` refreshes. The balance
 * is re-read every 15 seconds, plus once on mount — deliberately independent of
 * turn lifecycle, because a turn can run for minutes.
 *
 * Data: the authenticated Remote namespace `remote.account` —
 * `getBalance(client)` for the projected wallets
 * (`{ status, value: [{ currency, balance }], bonusWallets: [...] }`) and
 * `getState()` for `links.topUpUrl` / `links.usageUrl`.
 *
 * Factory form: this file must stay a CJS factory registered into
 * `window.__ModuleLoader__`; React comes from the shell's seed table.
 */
window.__ModuleLoader__.load({
  id: 'dsh-balance-indicator',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'conversation.composer.dock'
    const NS = 'balance-indicator'
    const ROW_ID = 'balance-indicator'
    const ROW_ORDER = 1000 // list slots sort by order ascending; the shipped `stats` pills use 0
    const CLIENT_VERSION = '0.2.0-rc.2'
    const REFRESH_MS = 15_000
    const RPC_TIMEOUT_MS = 20_000
    const BASELINE_PREFIX = 'dsh-balance-indicator:baseline:'
    /** Fraction digits shown for every amount, and the matching "is it zero" threshold. */
    const FRACTION_DIGITS = 3
    const ZERO_EPSILON = 0.5 * 10 ** -FRACTION_DIGITS

    const DICTIONARY = {
      en: {
        toppedUp: 'Topped-up balance',
        granted: 'Granted balance',
        toppedUpShort: 'Topped-up',
        grantedShort: 'Granted',
        sessionLabel: 'Session',
        spent: 'Change since this page opened',
        loading: 'Reading the account balance…',
        signedOut: 'Not signed in',
        failed: 'Balance unavailable',
        openTopUp: 'Open the top-up page',
        topUp: 'Top up',
        raw: 'Exact value',
        refresh: 'Refresh now',
        refreshShort: 'Refresh',
        resetSession: 'Reset the session spend',
        resetShort: 'reset',
      },
      zh: {
        toppedUp: '充值余额',
        granted: '赠送余额',
        toppedUpShort: '充值',
        grantedShort: '赠送',
        sessionLabel: '本次会话',
        spent: '自打开本页面以来的变化',
        loading: '正在读取账户余额…',
        signedOut: '未登录',
        failed: '余额不可用',
        openTopUp: '打开充值页面',
        topUp: '充值',
        raw: '原始值',
        refresh: '立即刷新',
        refreshShort: '刷新',
        resetSession: '将本次会话的支出归零',
        resetShort: '清零',
      },
    }

    /**
     * Compact symbols for the currencies the Platform reports. A map rather than
     * `Intl`'s currency symbol, which renders `CN¥` and `US$` in an English
     * locale while the reference layout wants a bare `¥` and `$`. Anything unknown
     * falls back to its ISO code, so a new currency still reads sensibly.
     */
    const SYMBOLS = {
      CNY: '¥',
      USD: '$',
      EUR: '€',
      GBP: '£',
      JPY: '¥',
      KRW: '₩',
      RUB: '₽',
      INR: '₹',
      BRL: 'R$',
      HKD: 'HK$',
      SGD: 'S$',
      AUD: 'A$',
      CAD: 'C$',
      TRY: '₺',
    }

    const describe = (error) =>
      error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)

    /** Accepts either the raw wallet array or the projected balance detail. */
    function readWallets(detail) {
      if (Array.isArray(detail)) return { wallets: detail, bonusWallets: [], status: 'ready' }
      if (detail && Array.isArray(detail.value)) {
        return {
          wallets: detail.value,
          bonusWallets: Array.isArray(detail.bonusWallets) ? detail.bonusWallets : [],
          status: typeof detail.status === 'string' ? detail.status : 'ready',
        }
      }
      return { wallets: [], bonusWallets: [], status: 'failed' }
    }

    /**
     * Plain number with FRACTION_DIGITS decimals. Deliberately not
     * `style: 'currency'`: the symbol is placed by this plugin, not by the
     * locale. Negatives keep their minus here.
     */
    function formatAmount(value, locale) {
      const amount = Number(value)
      if (!Number.isFinite(amount)) return String(value)
      const options = {
        minimumFractionDigits: FRACTION_DIGITS,
        maximumFractionDigits: FRACTION_DIGITS,
      }
      let format
      try {
        format = new Intl.NumberFormat(locale || undefined, options)
      } catch {
        format = new Intl.NumberFormat(undefined, options)
      }
      // The Platform keeps many digits (0.1068931130…), so a remainder below the
      // last shown digit would otherwise print as a signed zero ("-0.000").
      if (Math.abs(amount) < ZERO_EPSILON) return format.format(0)
      return format.format(amount)
    }

    function currencySymbol(currency) {
      return SYMBOLS[currency] || currency
    }

    /** Split form for callers that render the code separately from the figure. */
    function moneyParts(value, currency, locale) {
      const amount = Number(value)
      return {
        symbol: currencySymbol(currency),
        number: formatAmount(Number.isFinite(amount) ? Math.abs(amount) : amount, locale),
        negative: Number.isFinite(amount) && amount < 0 && Math.abs(amount) >= ZERO_EPSILON,
      }
    }

    /**
     * Symbol-first money: `¥1.910`, `$8.990`, and `-$0.010` for a debt — the minus
     * stays outside the symbol, and a magnitude that rounds to zero loses it.
     */
    function formatMoney(value, currency, locale) {
      const parts = moneyParts(value, currency, locale)
      return `${parts.negative ? '-' : ''}${parts.symbol}${parts.number}`
    }

    /** `¥1.910 CNY` — the tooltip spells the code out, since `$` alone is ambiguous. */
    function formatMoneyWithCode(value, currency, locale) {
      return `${formatMoney(value, currency, locale)} ${currency}`
    }

    /** Overwrites a stored baseline: this is how a reset is persisted. */
    function writeBaseline(slot, current) {
      try {
        window.sessionStorage.setItem(BASELINE_PREFIX + slot, String(current))
      } catch {
        // Blocked storage keeps the old anchor; the click stays harmless.
      }
      return current
    }

    /**
     * First balance seen for one wallet in this browser session, kept in
     * sessionStorage so a page reload does not silently reset the baseline. The
     * slot is `<group>:<currency>`, because one currency can hold both a topped-up
     * and a granted wallet, and they are spent independently.
     */
    function baselineFor(slot, current) {
      try {
        const key = BASELINE_PREFIX + slot
        const stored = window.sessionStorage.getItem(key)
        if (stored === null) {
          window.sessionStorage.setItem(key, String(current))
          return current
        }
        const parsed = Number(stored)
        return Number.isFinite(parsed) ? parsed : current
      } catch {
        return current
      }
    }

    /**
     * The host can leave a Remote call pending (credential read, Platform
     * stall), so the badge must never sit on "loading" forever. Each call gets
     * its own timer, which also keeps the two parallel calls independent.
     */
    function withTimeout(promise, label) {
      let timer
      return Promise.race([
        promise,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`${label} did not answer within ${RPC_TIMEOUT_MS / 1000}s`)),
            RPC_TIMEOUT_MS,
          )
        }),
      ]).finally(() => clearTimeout(timer))
    }

    /**
     * The row is a chip of its own. The dock's shipped token/cache pills are
     * borderless 999px pills with a transparent fill, so the same geometry plus a
     * subtle surface behind it keeps this entry in that visual language while
     * still reading as one plugin. Typography and colour come from the very
     * tokens those pills use, so a theme switch carries over.
     */
    const ROW_STYLE = {
      display: 'inline-grid',
      alignItems: 'center',
      // Two framed rows sit above each other, so a hairline gap would make their
      // borders read as one shape.
      rowGap: '3px',
      boxSizing: 'border-box',
      padding: '3px 10px',
      // Square on purpose: asked for explicitly, and it deliberately differs from
      // the dock's rounded pills so the balances read as their own block.
      borderRadius: '0',
      background: 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.13))',
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      fontSize: '11px',
      lineHeight: '15px',
      fontVariantNumeric: 'tabular-nums',
      whiteSpace: 'nowrap',
    }

    /** The marker gets its own size: emoji glyphs ignore the inherited line box. */
    const COIN_STYLE = {
      gridRow: '1 / -1',
      gridColumn: '1',
      fontSize: '13px',
      lineHeight: '1',
      alignSelf: 'center',
      justifySelf: 'center',
      paddingRight: '4px',
    }

    /**
     * Spacing lives on the cells rather than in `column-gap`, so the rhythm does
     * not depend on how the host lays the grid out. Labels stay muted and the
     * figures carry the emphasis; amounts are right-aligned inside their currency
     * column so the decimals line up down the chip.
     */
    const LABEL_STYLE = {
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      paddingRight: '12px',
    }
    const SESSION_LABEL_STYLE = {
      color: 'var(--dsw-alias-label-tertiary, #8b8b8b)',
      paddingLeft: '6px',
      // Roomier than the balance labels on purpose: the session figure reads as a
      // separate fact, not as another column of the table.
      paddingRight: '20px',
    }
    const AMOUNT_STYLE = {
      color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      fontWeight: 600,
      // Grid-level alignment, not `text-align`: it holds inside the shared column,
      // so the decimals of one row sit under the decimals of the other.
      justifySelf: 'end',
      paddingRight: '18px',
    }
    const SESSION_VALUE_STYLE = {
      color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      fontWeight: 600,
      // Only the reset sits to the right of the figure, so this padding is the whole
      // gap between them; the controls below are placed by column, not by padding.
      paddingRight: '6px',
    }

    /** Both controls are labelled buttons: `Refresh` and `Top up`. Square, like the frame. */
    const BUTTON_STYLE = {
      color: 'inherit',
      textDecoration: 'none',
      border: '0.5px solid currentColor',
      borderRadius: '0',
      padding: '0 7px',
      opacity: 0.75,
      cursor: 'pointer',
    }

    /**
     * The reset control is a word on a small fill: no frame, no underline. The fill
     * is only a hair taller than the text, so it marks the word as a control without
     * turning it into a box, and the neutral alpha keeps it readable in both themes.
     */
    const RESET_STYLE = {
      color: 'var(--dsw-alias-label-primary, #e6e6e6)',
      background: 'rgba(127, 127, 127, 0.20)',
      borderRadius: '0',
      padding: '0 4px',
      fontSize: '10px',
      lineHeight: '11px',
      fontWeight: 600,
      opacity: 1,
      cursor: 'pointer',
    }

    function BalanceIndicator(props) {
      const source = props.balanceSource
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const state = React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)

      const wallets = Array.isArray(state.wallets) ? state.wallets : []
      const bonusWallets = Array.isArray(state.bonusWallets) ? state.bonusWallets : []

      if (wallets.length === 0 && bonusWallets.length === 0) {
        const placeholder =
          state.status === 'loading' ? '…' : state.status === 'signed-out' ? '—' : '!'
        const title =
          state.status === 'signed-out'
            ? t('signedOut')
            : state.status === 'failed' || state.status === 'error'
              ? `${t('failed')}${state.error ? `: ${state.error}` : ''}`
              : t('loading')
        return h(
          'div',
          {
            'data-balance-indicator': state.status,
            // Flex here: a grid with no template would stack the marker and the
            // placeholder on two rows.
            style: { ...ROW_STYLE, display: 'inline-flex', gap: '4px' },
            title,
            onClick: () => void source.refresh(),
          },
          '💰 ',
          placeholder,
        )
      }

      const value = (wallet) => Number(wallet.balance)
      const shows = (wallet) => Number.isFinite(value(wallet)) && Math.abs(value(wallet)) >= ZERO_EPSILON
      const bySize = (left, right) => value(right) - value(left)

      // A balance under the last shown digit is noise, so it is dropped. When a
      // group has entries but none of them shows, the largest still appears as
      // `0.000`: a topped-up balance of zero is information, an empty group is not.
      const group = (list) => {
        const visible = list.filter(shows).sort(bySize)
        if (visible.length > 0) return visible
        return list.length > 0 ? [[...list].sort(bySize)[0]] : []
      }

      const topped = group(wallets)
      // Kept unfiltered as well: an emptied granted wallet leaves the row, but it
      // must still be able to drive the session figure.
      const grantedAll = bonusWallets.map((wallet) => ({ ...wallet, granted: true }))
      const granted = grantedAll.filter(shows).sort(bySize)

      // Every wallet carries its own baseline, because the Platform can draw the
      // session's spend from either the topped-up or the granted balance. The
      // figure therefore follows whichever wallet actually moved: anchoring it to
      // a fixed currency showed a frozen `0.000` while another wallet was paying.
      const movement = (wallet) => {
        const baseline = Number(wallet.baseline)
        return Number.isFinite(baseline) ? baseline - value(wallet) : 0
      }
      // Ranked over every wallet, including the ones the row hides as dust: a
      // wallet spent down to nothing is exactly the spend worth reporting, and
      // dropping it here would reset the figure the moment it emptied.
      const ranked = [...wallets, ...grantedAll]
        .map((wallet) => ({ wallet, change: movement(wallet) }))
        .sort((left, right) => Math.abs(right.change) - Math.abs(left.change))
      const moved = ranked[0]
      // With nothing moving yet, the figure names the account's main currency:
      // this route carries no FX rates, so "main" is the largest number reported.
      const main =
        moved && moved.change !== 0
          ? moved
          : { wallet: [...topped, ...granted].sort(bySize)[0], change: 0 }
      const mainWallet = main.wallet
      const change = main.change
      const mainNumber = value(mainWallet)
      // True but below the last shown digit: rendered as zero, with the raw value
      // kept in the tooltip.
      const subCent = mainNumber !== 0 && Math.abs(mainNumber) < ZERO_EPSILON

      const links = state.links || null
      const target = links ? links.topUpUrl || links.usageUrl || null : null

      const groupText = (list) =>
        list
          .map((wallet) => formatMoneyWithCode(wallet.balance, wallet.currency, state.locale))
          .join(' + ')

      // One amount column per currency, shared by both rows, so a dollar sits under
      // a dollar and a yuan under a yuan. The order comes from the topped-up row
      // (largest first), then any currency only the granted row holds.
      const currencyOrder = []
      for (const wallet of [...topped, ...granted]) {
        if (!currencyOrder.includes(wallet.currency)) currencyOrder.push(wallet.currency)
      }
      const amountOf = (list, currency) => {
        const wallet = list.find((entry) => entry.currency === currency)
        return wallet ? formatMoney(wallet.balance, currency, state.locale) : ''
      }

      // Explicit positions on both axes. Auto-placement cannot be trusted here: the
      // controls are placed in the second row, which leaves a free cell in their
      // column on the first row, and the granted label gets pulled up into it.
      const cells = [
        h('span', { key: 'coin', style: COIN_STYLE }, '💰'),
      ]
      const pushBalanceRow = (prefix, label, list, row) => {
        cells.push(
          h(
            'span',
            {
              key: `${prefix}-label`,
              style: { ...LABEL_STYLE, gridRow: String(row), gridColumn: '2' },
            },
            `${t(label)}:`,
          ),
        )
        currencyOrder.forEach((currency, index) => {
          cells.push(
            h(
              'span',
              {
                key: `${prefix}-${currency}`,
                style: { ...AMOUNT_STYLE, gridRow: String(row), gridColumn: String(3 + index) },
              },
              amountOf(list, currency),
            ),
          )
        })
      }
      pushBalanceRow('topped', 'toppedUpShort', topped, 1)
      const sessionColumn = 3 + currencyOrder.length
      cells.push(
        h(
          'span',
          {
            key: 'session-label',
            style: { ...SESSION_LABEL_STYLE, gridRow: '1', gridColumn: String(sessionColumn) },
          },
          `${t('sessionLabel')}:`,
        ),
      )
      cells.push(
        h(
          'span',
          {
            key: 'session-value',
            style: { ...SESSION_VALUE_STYLE, gridRow: '1', gridColumn: String(sessionColumn + 1) },
          },
          formatMoney(change, mainWallet.currency, state.locale),
        ),
      )
      // The reset shares the controls' column, one row above them: that keeps the
      // block narrow and puts it directly over the button it relates to.
      cells.push(
        h(
          'span',
          {
            key: 'reset',
            role: 'button',
            tabIndex: 0,
            title: t('resetSession'),
            'aria-label': t('resetSession'),
            style: {
              ...RESET_STYLE,
              gridRow: '1',
              gridColumn: `${sessionColumn + 2} / -1`,
              alignSelf: 'center',
              justifySelf: 'start',
            },
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              if (typeof source.resetBaseline === 'function') source.resetBaseline()
            },
          },
          t('resetShort'),
        ),
      )
      if (granted.length > 0) pushBalanceRow('granted', 'grantedShort', granted, 2)

      const controls = [
        h(
          'span',
          {
            key: 'refresh',
            role: 'button',
            tabIndex: 0,
            title: t('refresh'),
            style: BUTTON_STYLE,
            onClick: (event) => {
              event.preventDefault()
              event.stopPropagation()
              void source.refresh()
            },
          },
          t('refreshShort'),
        ),
      ]
      if (target) {
        controls.push(
          h(
            'a',
            {
              key: 'topup',
              href: target,
              target: '_blank',
              rel: 'noreferrer',
              title: t('openTopUp'),
              style: BUTTON_STYLE,
              onClick: (event) => event.stopPropagation(),
            },
            t('topUp'),
          ),
        )
      }
      // The controls start on the session label's column, exactly where they sat
      // before the reset control existed: the reset occupies its own column in the
      // first row and must not push the buttons anywhere.
      cells.push(
        h(
          'span',
          {
            key: 'controls',
            style: {
              gridRow: granted.length > 0 ? '2' : '1',
              gridColumn: `${sessionColumn} / -1`,
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              justifySelf: 'start',
            },
          },
          ...controls,
        ),
      )
      // Columns: coin, label, one per currency, session label, session value, controls.
      // The reset lives in the controls' column, so no extra track is needed.
      const gridTemplateColumns = [
        'auto',
        'auto',
        ...currencyOrder.map(() => 'auto'),
        'auto',
        'auto',
        'auto',
      ].join(' ')

      const title = [
        `${t('toppedUp')}: ${groupText(topped)}`,
        granted.length > 0 ? `${t('granted')}: ${groupText(granted)}` : null,
        // The row is too narrow to name the wallet; the tooltip says which one moved.
        `${t('sessionLabel')}: ${formatMoney(change, mainWallet.currency, state.locale)}${
          change !== 0
            ? ` — ${mainWallet.granted ? t('grantedShort') : t('toppedUpShort')} ${mainWallet.currency}`
            : ''
        }`,
        subCent ? `${t('raw')}: ${mainWallet.balance} ${mainWallet.currency}` : null,
        t('spent'),
        target ? t('openTopUp') : t('refresh'),
      ]
        .filter(Boolean)
        .join('\n')

      // The row is inert: navigation lives on its own button, so nothing competes
      // with the refresh control for a click.
      return h(
        'div',
        {
          'data-balance-indicator': state.status,
          style: {
            ...ROW_STYLE,
            gridTemplateColumns,
            // Explicit rows are required: the coin spans `1 / -1`, and `-1` only
            // counts the explicit grid — with implicit rows it would cover the
            // first row alone and the granted label would slide under it.
            gridTemplateRows: granted.length > 0 ? 'auto auto' : 'auto',
          },
          title,
        },
        ...cells,
      )
    }

    // `remote.account` must be declared, not just `remote`: Cordis has to know
    // the namespaced RPC service before a call can be answered, the same way
    // @deepseek-ai/dsh-client-ui-chat declares `remote.session`.
    const inject = ['slots', 'remote', 'remote.account', 'locale']

    function apply(ctx) {
      const listeners = new Set()
      let snapshot = {
        status: 'loading',
        wallets: [],
        bonusWallets: [],
        links: null,
        error: null,
        locale: 'en',
      }

      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
      const getSnapshot = () => snapshot
      const publish = (next) => {
        snapshot = next
        for (const listener of Array.from(listeners)) {
          try {
            listener()
          } catch {
            // A broken subscriber must not stop the refresh loop.
          }
        }
      }

      const activeLocale = () => {
        try {
          const current = ctx.locale.getSnapshot()
          return (current && current.active) || 'en'
        } catch {
          return 'en'
        }
      }

      // A 15s cadence is shorter than the 20s call timeout: without this guard a
      // slow read would stack further requests behind it.
      let inFlight = false

      const refresh = async () => {
        if (inFlight) return
        inFlight = true
        const locale = activeLocale()
        const account = ctx.remote && ctx.remote.account
        if (!account || typeof account.getBalance !== 'function') {
          inFlight = false
          publish({ ...snapshot, status: 'failed', error: 'remote.account is unavailable', locale })
          return
        }
        try {
          const meta = {
            version: CLIENT_VERSION,
            locale,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }
          // Both calls run together: a slow or failing getState must not hold
          // back the balance, and the links are optional decoration.
          const [result, accountState] = await Promise.all([
            withTimeout(account.getBalance(meta), 'remote.account.getBalance'),
            typeof account.getState === 'function'
              ? withTimeout(account.getState(), 'remote.account.getState').catch(() => null)
              : Promise.resolve(null),
          ])
          let links = snapshot.links
          if (accountState && accountState.ok && accountState.value && accountState.value.links) {
            links = accountState.value.links
          }
          if (result === null || result === undefined) {
            publish({ status: 'signed-out', wallets: [], bonusWallets: [], links, error: null, locale })
            return
          }
          if (!result.ok) {
            publish({ ...snapshot, status: 'failed', links, error: describe(result.error), locale })
            return
          }
          const detail = readWallets(result.value)
          publish({
            status: detail.status,
            wallets: detail.wallets.map((wallet) => ({
              ...wallet,
              // Anchored at the first read of this currency on this page, not at
              // the first render: the dock can mount long after boot. Keyed by
              // group as well, since one currency can hold both wallets and they
              // are spent independently.
              baseline: baselineFor(`topped:${wallet.currency}`, Number(wallet.balance)),
            })),
            bonusWallets: detail.bonusWallets.map((wallet) => ({
              ...wallet,
              baseline: baselineFor(`granted:${wallet.currency}`, Number(wallet.balance)),
            })),
            links,
            error: null,
            locale,
          })
        } catch (error) {
          publish({ ...snapshot, status: 'error', error: describe(error), locale })
        } finally {
          inFlight = false
        }
      }

      /**
       * Re-anchors every wallet at its current balance. The session figure is a
       * balance delta, so zeroing it means moving the anchor — not accumulating a
       * correction that the next read would sweep away.
       */
      const resetBaseline = () => {
        const anchor = (wallet, slot) => ({
          ...wallet,
          baseline: writeBaseline(`${slot}:${wallet.currency}`, Number(wallet.balance)),
        })
        publish({
          ...snapshot,
          wallets: (snapshot.wallets || []).map((wallet) => anchor(wallet, 'topped')),
          bonusWallets: (snapshot.bonusWallets || []).map((wallet) => anchor(wallet, 'granted')),
        })
      }

      ctx.effect(
        () => {
          try {
            return ctx.locale.register(NS, DICTIONARY)
          } catch (error) {
            // A rejected dictionary must not take the whole plugin row down.
            console.warn('[balance-indicator] locale dictionary was rejected', error)
            return undefined
          }
        },
        'balance-indicator: locale dictionary',
      )

      ctx.effect(() => {
        void refresh()
        // The account namespace can still be registering right after boot, so one
        // early retry covers that gap; the 15s cadence handles everything after.
        const bootstrap = [2_000].map((delay) =>
          setTimeout(() => {
            if (snapshot.status !== 'ready') void refresh()
          }, delay),
        )
        const timer = setInterval(() => void refresh(), REFRESH_MS)
        return () => {
          for (const handle of bootstrap) clearTimeout(handle)
          clearInterval(timer)
        }
      }, 'balance-indicator: balance refresh loop')

      try {
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: ROW_ID,
              order: ROW_ORDER,
              locale: NS,
              inject: () => ({ balanceSource: { subscribe, getSnapshot, refresh, resetBaseline } }),
            },
            BalanceIndicator,
          ),
        )
      } catch (error) {
        console.error(`[balance-indicator] could not register into ${SLOT}`, error)
      }
    }

    return { inject, apply }
  },
})
