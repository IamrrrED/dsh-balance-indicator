/**
 * Host half of `dsh-balance-indicator`.
 *
 * The badge itself is driven by the browser half through the authenticated
 * Remote namespace `remote.account` (the shipped account controller calls
 * `ctx.deepseekAccount.getBalance`). This half renders nothing and exposes no
 * service; it exists because a profile bundle mounts a loader row, and it adds
 * two diagnostic notes:
 *
 * 1. one line in `<DSH_HOME>/balance-indicator.log` when the row activates;
 * 2. one probe of the same balance service, so the data path is verifiable
 *    without looking at the page.
 *
 * `inject` is mandatory here: in Cordis, reading a service that the plugin did
 * not declare throws, which would abort `apply` after the first note.
 *
 * @module dsh-balance-indicator
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-balance-indicator'

/** The account service owns the balance query that the client RPC wraps. */
export const inject = ['deepseekAccount']

const LOG_PATH = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'balance-indicator.log')

/** Diagnostics must never break activation, so every failure is swallowed. */
function note(line) {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // An unwritable log is not a reason to fail the plugin row.
  }
}

function describe(error) {
  return error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error)
}

/** Unwraps the projected balance detail into the wallet list. */
function walletsOf(result) {
  const detail = result && typeof result === 'object' && 'value' in result ? result.value : result
  if (Array.isArray(detail)) return detail
  if (detail && Array.isArray(detail.value)) return detail.value
  return null
}

/**
 * Registers nothing; observes the account service once for diagnostics.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  note('host half activated')
  let account
  try {
    account = ctx.deepseekAccount
  } catch (error) {
    note(`service access failed: ${describe(error)}`)
    return
  }
  if (!account || typeof account.getBalance !== 'function') {
    note('deepseekAccount.getBalance is unavailable — the client RPC would fail too')
    return
  }
  note('probing balance')
  void (async () => {
    try {
      const result = await account.getBalance({
        version: '0.2.0-rc.2',
        locale: 'en',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      })
      if (result === null || result === undefined) {
        note('balance probe: no account grant (not signed in)')
        return
      }
      const wallets = walletsOf(result)
      if (wallets === null) {
        note(`balance probe: unexpected shape ${JSON.stringify(result).slice(0, 200)}`)
        return
      }
      const summary = wallets.map((wallet) => `${wallet.currency}=${wallet.balance}`).join(' ')
      note(`balance probe ok: ${summary || '(no wallets)'}`)
    } catch (error) {
      note(`balance probe failed: ${describe(error)}`)
    }
  })()
}
