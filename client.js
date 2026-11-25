window.__ModuleLoader__.load({
  id: '@local/dsh-english-quiz',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'english-quiz'
    const KIND = 'english-quiz'
    const PROJECTION = 'englishQuiz'
    const SUBMIT_PATH = '/plugins/english-quiz/submit'
    const STATS_PATH = '/plugins/english-quiz/stats'

    const ZH = {
      title: '填空练习',
      'view.progress': '英语统计',
      'answer.submit': '提交',
      'answer.cancel': '结束',
      'answer.filled': '已填',
      'answer.blank': '空',
      'answer.sending': '提交中…',
      'review.title': '结果',
      'review.blanks': '空正确',
      'review.items': '句全对',
      'review.expected': '应为',
      'review.yours': '你填',
      'review.skipped': '未作答',
      'review.wrong': '错',
      'review.reinforce': '巩固这',
      'review.reinforceSuffix': '个错点',
      'review.next': '换一组',
      'review.done': '结束',
      'review.perfect': '全对，本轮结束。',
      'answer.failed': '提交失败，请重试',
    }

    const EN = {
      title: 'Fill-in-the-blank',
      'view.progress': 'English stats',
      'answer.submit': 'Submit',
      'answer.cancel': 'End',
      'answer.filled': 'Filled',
      'answer.blank': 'blanks',
      'answer.sending': 'Submitting…',
      'review.title': 'Result',
      'review.blanks': 'blanks correct',
      'review.items': 'sentences perfect',
      'review.expected': 'Answer',
      'review.yours': 'You wrote',
      'review.skipped': 'Skipped',
      'review.wrong': 'Wrong',
      'review.reinforce': 'Drill',
      'review.reinforceSuffix': 'mistakes',
      'review.next': 'Another set',
      'review.done': 'Done',
      'review.perfect': 'All correct. This round is done.',
      'answer.failed': 'Submit failed, please retry',
    }

    let manager = null

    // -----------------------------------------------------------------
    // Card manager: projection -> pending interaction -> composer card
    // -----------------------------------------------------------------

    class QuizManager {
      constructor(ctx) {
        this.ctx = ctx
        this.cards = new Map()
        this.stops = new Map()
        this.stopList = null
        this.publish = ctx.uiSession.registerPendingInteraction(() => 1)
      }

      start() {
        this.stopList = this.ctx.sessions.list.subscribe(() => this.reconcile())
        this.reconcile()
      }

      dispose() {
        if (this.stopList !== null) this.stopList()
        this.stopList = null
        for (const stop of this.stops.values()) stop()
        this.stops.clear()
        for (const card of this.cards.values()) card.dispose?.()
        this.cards.clear()
      }

      reconcile() {
        let snapshot
        try {
          snapshot = this.ctx.sessions.list.getSnapshot()
        } catch {
          return
        }
        const byId = snapshot?.byId ?? {}
        const bound = new Map()
        for (const id of Object.keys(byId)) {
          const binding = this.ctx.sessions.binding(id)
          if (binding !== undefined) bound.set(id, binding)
        }
        for (const [id, stop] of this.stops) {
          if (!bound.has(id)) {
            stop()
            this.stops.delete(id)
            this.drop(id)
          }
        }
        for (const [id, binding] of bound) {
          if (this.stops.has(id)) continue
          const face = binding.session.projections.faceOf(PROJECTION)
          const stop = face.subscribe(() => this.sync(id, binding))
          this.stops.set(id, stop)
          this.sync(id, binding)
        }
      }

      sync(id, binding) {
        let view
        try {
          view = binding.session.projections.faceOf(PROJECTION).getSnapshot()
        } catch {
          return
        }
        const pending = view !== null && typeof view === 'object' ? view.pending : null
        const card = this.cards.get(id)
        if (pending !== null && pending !== undefined) {
          if (card === undefined || card.quiz.callId !== pending.callId) {
            this.drop(id)
            this.showAnswer(id, pending)
          }
          return
        }
        if (card !== undefined && card.phase === 'answering' && !card.submitting) this.drop(id)
      }

      showAnswer(id, quiz) {
        const interaction = {
          key: `${KIND}:${quiz.callId}:answer`,
          kind: KIND,
          sessionId: id,
          phase: 'answering',
          quiz,
        }
        const dispose = this.publish(interaction, async () => {})
        this.cards.set(id, {
          quiz,
          phase: 'answering',
          interaction,
          dispose,
          submitting: false,
        })
      }

      showReview(id, card, result) {
        if (this.cards.get(id) !== card) return
        card.dispose?.()
        card.submitting = false
        card.phase = 'review'
        card.result = result
        const interaction = {
          key: `${KIND}:${card.quiz.callId}:review`,
          kind: KIND,
          sessionId: id,
          phase: 'review',
          quiz: card.quiz,
          result,
        }
        card.interaction = interaction
        card.dispose = this.publish(interaction, async () => {})
      }

      async submit(id, values, textValues) {
        const card = this.cards.get(id)
        if (card === undefined || card.submitting) return
        card.submitting = true
        const answers = []
        const translations = []
        card.quiz.items.forEach((item, itemIndex) => {
          if (item.kind === 'translate') {
            const text = textValues?.[`t${itemIndex}`]
            translations.push({ itemId: item.id, text: typeof text === 'string' ? text : '' })
            return
          }
          for (const segment of item.segments ?? []) {
            if (segment === null || typeof segment !== 'object') continue
            const key = `b${itemIndex}/${segment.blank}`
            const given = values[key]
            answers.push({
              itemId: item.id,
              blankId: segment.blank,
              given: typeof given === 'string' ? given : '',
            })
          }
        })
        let response
        try {
          response = await fetch(SUBMIT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ callId: card.quiz.callId, answers, translations }),
          })
        } catch (error) {
          card.submitting = false
          throw error
        }
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!response.ok || data === null || data.ok !== true || data.result === undefined) {
          card.submitting = false
          throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`)
        }
        this.showReview(id, card, data.result)
      }

      async submitText(id, text) {
        const card = this.cards.get(id)
        if (card === undefined || card.submitting) return
        card.submitting = true
        let response
        try {
          response = await fetch(SUBMIT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ callId: card.quiz.callId, text }),
          })
        } catch (error) {
          card.submitting = false
          throw error
        }
        let data = null
        try {
          data = await response.json()
        } catch {
          data = null
        }
        if (!response.ok || data === null || data.ok !== true || data.result === undefined) {
          card.submitting = false
          throw new Error(typeof data?.error === 'string' ? data.error : `HTTP ${response.status}`)
        }
        this.showReview(id, card, data.result)
      }

      dismiss(id) {
        const card = this.cards.get(id)
        if (card === undefined) return
        if (card.phase === 'answering') {
          void fetch(SUBMIT_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ callId: card.quiz.callId, cancel: true }),
          }).catch(() => {})
        }
        this.drop(id)
      }

      reinforce(id, mode) {
        const card = this.cards.get(id)
        if (card === undefined || card.phase !== 'review') return
        const binding = this.ctx.sessions.binding(id)
        if (binding !== undefined) {
          let text
          if (card.quiz.mode === 'prompt') {
            text = mode === 'next' ? '再给我一个自由表达的主题，换个场景。' : '再给我一个自由表达的主题。'
          } else if (card.quiz.mode === 'translate') {
            text = '再给我一句中译英，换个句子。'
          } else {
            const mixed = (card.quiz.items ?? []).some((item) => item.kind === 'translate')
            text = mode === 'next'
              ? (mixed ? '换一组混合练习，考点不变，换新语境。' : '换一组填空，考点不变，换新语境。')
              : reinforceText(card.result)
          }
          void binding.session.prompt([{ type: 'text', text }], 'queue').catch(() => {})
        }
        this.drop(id)
      }

      drop(id) {
        const card = this.cards.get(id)
        if (card === undefined) return
        card.dispose?.()
        this.cards.delete(id)
      }
    }

    function reinforceText(result) {
      const wrong = []
      for (const item of result?.items ?? []) {
        if (item.kind === 'translate') {
          if (item.ok) continue
          const expected = Array.isArray(item.expected) ? item.expected[0] : ''
          wrong.push(
            `${item.point}：「${item.given === '' ? '空着' : item.given}」应为「${expected}」`,
          )
          continue
        }
        for (const blank of item.blanks ?? []) {
          if (blank.ok) continue
          const expected = Array.isArray(blank.expected) ? blank.expected[0] : ''
          wrong.push(
            `${item.point}：「${blank.given === '' ? '空着' : blank.given}」应为「${expected}」`,
          )
        }
      }
      if (wrong.length === 0) return '再出一组同考点的混合练习，换新语境。'
      return `巩固这组错点：${wrong.join('；')}。请出新的一组 4-6 句，换语境，别重复原句。`
    }

    // -----------------------------------------------------------------
    // Card component
    // -----------------------------------------------------------------

    function translate(props) {
      const t = typeof props.t === 'function' ? props.t : null
      return (key, fallback) => {
        if (t !== null) {
          try {
            const value = t(key)
            if (typeof value === 'string' && value !== key) return value
          } catch {
            // Fall through to the local dictionary.
          }
        }
        return ZH[key] ?? fallback ?? key
      }
    }

    let speechVoice = null
    const RATES = [1, 0.8, 0.5]
    const RATE_STORAGE_KEY = 'dsh-english-quiz.rate'
    let speechRate = readStoredRate()

    function readStoredRate() {
      try {
        const value = Number(window.localStorage?.getItem(RATE_STORAGE_KEY))
        return RATES.includes(value) ? value : 1
      } catch {
        return 1
      }
    }

    function storeRate(value) {
      try {
        window.localStorage?.setItem(RATE_STORAGE_KEY, String(value))
      } catch {
        // A blocked storage area only loses the preference.
      }
    }

    function RateControl() {
      const [rate, setRate] = useState(speechRate)
      return h(
        'label',
        { className: 'eqz-rate', title: '朗读语速' },
        h('span', { className: 'eqz-rate-label' }, '语速'),
        h(
          'select',
          {
            value: String(rate),
            'aria-label': '朗读语速',
            onChange: (event) => {
              const next = Number(event.target.value)
              if (!RATES.includes(next)) return
              speechRate = next
              storeRate(next)
              setRate(next)
            },
          },
          RATES.map((value) => h('option', { key: String(value), value: String(value) }, `×${value}`)),
        ),
      )
    }

    function StatsIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('rect', { x: 4, y: 12, width: 3.5, height: 8, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 10.25, y: 8, width: 3.5, height: 12, rx: 1, fill: 'currentColor' }),
        h('rect', { x: 16.5, y: 4, width: 3.5, height: 16, rx: 1, fill: 'currentColor' }),
      )
    }

    const STATS_STYLE = `
/* Hallmark · shape: app screen · genre: modern-minimal (inferred) · theme: DSH host tokens · v2.0.0 */
/* direction: host tokens, no theme deal; this panel is embedded in DSH and borrows its palette, faces, radius and surfaces */
/* pre-emit critique: P4 H5 E4 S4 R4 V3 · weakest: V; a stats panel is category-typical, so the 14-day ledger strip and the next-focus row carry it */
.eqz-stats-page,.eqz-stats-page *{box-sizing:border-box}
.eqz-stats-page{max-width:1040px;margin:0 auto;padding:28px 24px 64px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6;overflow-x:clip}
.eqz-stats-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px}
.eqz-stats-heading{min-width:0}
.eqz-stats-title{margin:0;font-size:20px;font-weight:600;line-height:1.3;overflow-wrap:break-word;min-width:0}
.eqz-stats-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.eqz-stats-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.eqz-stats-updated{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap}
.eqz-sbtn{height:32px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1;cursor:pointer}
.eqz-sbtn:hover{background:var(--dsw-alias-bg-layer-2)}
.eqz-sbtn:disabled{opacity:.55;cursor:default}
.eqz-sbtn-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.eqz-sbtn-primary:hover{background:var(--dsw-alias-bg-layer-2)}
.eqz-sbtn:active{transform:translateY(1px)}
.eqz-stats-page button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.eqz-overview{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.5fr);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;margin-bottom:12px}
.eqz-tally{padding:20px 24px;border-right:1px solid var(--dsw-alias-border-l1);min-width:0}
.eqz-tally-label{color:var(--dsw-alias-label-secondary);font-size:12px}
.eqz-tally-value{margin-top:4px;font-size:44px;font-weight:600;line-height:1.05;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.eqz-tally-value span{margin-left:2px;font-size:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.eqz-tally-note{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));margin:0;padding:12px 0}
.eqz-fact{padding:8px 24px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}
.eqz-fact:nth-last-child(-n+2){border-bottom:0}
.eqz-fact dt{color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-fact dd{margin:4px 0 0;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.eqz-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin-bottom:12px}
.eqz-panel{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 20px;min-width:0}
.eqz-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px;min-width:0}
.eqz-panel-title{font-size:13px;font-weight:600;min-width:0;overflow-wrap:break-word}
.eqz-panel-note{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-focus{display:flex;flex-direction:column;gap:16px}
.eqz-focus-row{min-width:0}
.eqz-focus-top{display:flex;align-items:center;gap:8px;min-width:0}
.eqz-focus-name{font-size:13px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.eqz-focus-pct{margin-left:auto;font-size:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.eqz-bar{height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin-top:8px}
.eqz-bar-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}
.eqz-bar-fill.is-bad{background:var(--dsw-alias-state-error-primary)}
.eqz-bar-fill.is-warn{background:var(--dsw-alias-state-warn-primary)}
.eqz-bar-fill.is-ok{background:var(--dsw-alias-state-success-primary)}
.eqz-focus-meta{display:flex;gap:12px;margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}
.eqz-chip{display:inline-flex;align-items:center;height:20px;padding:0 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:11px;line-height:1;white-space:nowrap}
.eqz-chip-bad{color:var(--dsw-alias-state-error-primary)}
.eqz-chip-warn{color:var(--dsw-alias-state-warn-primary)}
.eqz-chip-ok{color:var(--dsw-alias-state-success-primary)}
.eqz-note-block{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7;padding:4px 0}
.eqz-activity{display:flex;align-items:stretch;gap:4px;height:126px;padding-top:8px}
.eqz-day-col{display:flex;flex-direction:column;justify-content:flex-end;flex:1;min-width:0;gap:4px}
.eqz-day-bar-wrap{display:flex;align-items:flex-end;flex:1;min-height:0}
.eqz-day-bar{width:100%;max-width:24px;margin:0 auto;min-height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-brand-primary);opacity:.55}
.eqz-day-col.is-today .eqz-day-bar{opacity:1}
.eqz-day-col.is-empty .eqz-day-bar{background:var(--dsw-alias-bg-layer-2);opacity:1}
.eqz-day-label{height:14px;line-height:14px;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center;white-space:nowrap}
.eqz-chart-note{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-anki{margin-bottom:12px}
.eqz-anki-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:0 0 8px}
.eqz-anki-fact{min-width:0}
.eqz-anki-fact dt{color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-anki-fact dd{margin:4px 0 0;font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}
.eqz-activity-anki{height:84px}
.eqz-anki-decks{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:12px;color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-anki-decks-label{margin-right:2px}
.eqz-anki-note{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.7}
.eqz-table-wrap{overflow-x:auto;margin:0 -4px;padding:0 4px}
.eqz-table{width:100%;min-width:560px;border-collapse:collapse;font-size:12px}
.eqz-table th{text-align:left;padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;white-space:nowrap}
.eqz-table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.eqz-table tr:last-child td{border-bottom:0}
.eqz-table .eqz-col-point{white-space:normal;min-width:120px}
.eqz-num{text-align:right;font-variant-numeric:tabular-nums}
.eqz-bottom{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.eqz-bottom-col{padding:16px 20px;min-width:0}
.eqz-bottom-col + .eqz-bottom-col{border-left:1px solid var(--dsw-alias-border-l1)}
.eqz-record{display:flex;flex-direction:column;gap:12px}
.eqz-record-item{min-width:0}
.eqz-record-top{display:flex;align-items:center;gap:8px;min-width:0}
.eqz-record-point{font-size:12px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.eqz-record-prompt{margin-top:4px;color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eqz-record-answer{display:flex;align-items:baseline;gap:4px;flex-wrap:wrap;margin-top:4px;font-size:12px}
.eqz-record-label{color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-record-given{color:var(--dsw-alias-state-error-primary)}
.eqz-record-expected{color:var(--dsw-alias-state-success-primary)}
.eqz-record-spell{color:var(--dsw-alias-state-warn-primary)}
.eqz-foot{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.7}
.eqz-foot p{margin:0}
.eqz-empty{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:44px 20px;text-align:center}
.eqz-empty-title{font-size:15px;font-weight:600}
.eqz-empty-note{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.eqz-empty .eqz-sbtn{margin-top:16px}
.eqz-skeleton{display:flex;flex-direction:column;gap:12px}
.eqz-sk{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px}
.eqz-sk-overview{height:150px}
.eqz-sk-panel{height:190px}
.eqz-sk-table{height:230px}
.eqz-sk-line{height:12px;border-radius:6px;background:var(--dsw-alias-bg-layer-2)}
.eqz-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media (max-width:900px){
.eqz-overview{grid-template-columns:minmax(0,1fr)}
.eqz-anki-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.eqz-tally{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}
.eqz-split{grid-template-columns:minmax(0,1fr)}
.eqz-bottom{grid-template-columns:minmax(0,1fr)}
.eqz-bottom-col + .eqz-bottom-col{border-left:0;border-top:1px solid var(--dsw-alias-border-l1)}
}
@media (max-width:560px){
.eqz-stats-page{padding:20px 16px 48px}
.eqz-stats-head{flex-direction:column;align-items:flex-start}
.eqz-stats-actions{justify-content:flex-start}
.eqz-day-label{visibility:hidden}
.eqz-day-col:first-child .eqz-day-label,.eqz-day-col:last-child .eqz-day-label{visibility:visible}
}
`

    function formatStatsDate(value) {
      if (typeof value !== 'string' || value === '') return '暂无'
      return value.length >= 10 ? value.slice(5, 10) : value
    }

    function formatStatsWhen(value) {
      if (typeof value !== 'string' || value === '') return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (part) => String(part).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function formatStatsDuration(minutes) {
      if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return '0 分'
      if (minutes < 60) return `${minutes} 分`
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分`
    }

    function pointStatus(point) {
      if (point.accuracy === null) return { label: '记录中', className: '', barClass: '' }
      if (point.attempts < 2) return { label: '刚起步', className: '', barClass: '' }
      if (point.accuracy < 60) return { label: '待巩固', className: 'eqz-chip-bad', barClass: 'is-bad' }
      if (point.accuracy < 80) return { label: '在练', className: 'eqz-chip-warn', barClass: 'is-warn' }
      return { label: '稳', className: 'eqz-chip-ok', barClass: 'is-ok' }
    }

    function StatsFact({ label, value }) {
      return h('div', { className: 'eqz-fact' }, h('dt', null, label), h('dd', null, value))
    }

    function StatsOverview({ stats, weakCount }) {
      return h(
        'section',
        { className: 'eqz-overview', 'aria-label': '总览' },
        h(
          'div',
          { className: 'eqz-tally' },
          h('div', { className: 'eqz-tally-label' }, '总正确率'),
          h(
            'div',
            { className: 'eqz-tally-value' },
            stats.accuracy === null ? '暂无' : String(stats.accuracy),
            stats.accuracy === null ? null : h('span', null, '%'),
          ),
          h(
            'div',
            { className: 'eqz-tally-note' },
            stats.scored === 0 ? '还没有可判分的答题' : `${stats.correct} / ${stats.scored} 次正确`,
          ),
        ),
        h(
          'dl',
          { className: 'eqz-facts' },
          h(StatsFact, { label: '练习组数', value: String(stats.sets ?? 0) }),
          h(StatsFact, { label: '答题次数', value: String(stats.attempts) }),
          h(StatsFact, { label: '连续练习', value: `${stats.streak ?? 0} 天` }),
          h(StatsFact, { label: '待巩固', value: `${weakCount} 个` }),
        ),
      )
    }

    function StatsFocus({ focus, copy, copyState }) {
      const idleLabel = focus.length === 0 ? '复制练习指令' : '复制练习清单'
      const label = copyState === 'ok' ? '已复制' : copyState === 'fail' ? '复制失败' : idleLabel
      return h(
        'section',
        { className: 'eqz-panel' },
        h(
          'div',
          { className: 'eqz-panel-head' },
          h(
            'div',
            null,
            h('div', { className: 'eqz-panel-title' }, '接下来练'),
            h(
              'div',
              { className: 'eqz-panel-note' },
              focus.length === 0 ? '再积累几次答题' : '正确率低于 80%',
            ),
          ),
          h(
            'button',
            { type: 'button', className: 'eqz-sbtn eqz-sbtn-primary', onClick: copy, 'aria-live': 'polite' },
            label,
          ),
        ),
        focus.length === 0
          ? h('div', { className: 'eqz-note-block' }, '还没有足够的数据判断薄弱点。再练一组，这里会给出优先项。')
          : h(
            'div',
            { className: 'eqz-focus' },
            focus.map((point) => {
              const status = pointStatus(point)
              return h(
                'div',
                { key: point.point, className: 'eqz-focus-row' },
                h(
                  'div',
                  { className: 'eqz-focus-top' },
                  h('span', { className: 'eqz-focus-name', title: point.point }, point.point),
                  h('span', { className: `eqz-chip ${status.className}` }, status.label),
                  h(
                    'span',
                    { className: 'eqz-focus-pct' },
                    point.accuracy === null ? '暂无' : `${point.accuracy}%`,
                  ),
                ),
                h(
                  'div',
                  { className: 'eqz-bar' },
                  h('div', {
                    className: `eqz-bar-fill ${status.barClass}`,
                    style: { width: `${point.accuracy ?? 0}%` },
                  }),
                ),
                h(
                  'div',
                  { className: 'eqz-focus-meta' },
                  h('span', null, `${point.attempts} 次`),
                  h('span', null, `最近 ${formatStatsDate(point.lastSeen)}`),
                ),
              )
            }),
          ),
      )
    }

    function StatsActivity({ daily }) {
      const days = Array.isArray(daily) ? daily : []
      const total = days.reduce((sum, day) => sum + day.attempts, 0)
      const max = Math.max(1, ...days.map((day) => day.attempts))
      return h(
        'section',
        { className: 'eqz-panel' },
        h(
          'div',
          { className: 'eqz-panel-head' },
          h(
            'div',
            null,
            h('div', { className: 'eqz-panel-title' }, '最近 14 天'),
            h('div', { className: 'eqz-panel-note' }, `${total} 次答题`),
          ),
        ),
        days.length === 0 || total === 0
          ? h('div', { className: 'eqz-note-block' }, '最近 14 天没有记录。')
          : h(
            'div',
            null,
            h(
              'div',
              { className: 'eqz-activity', role: 'img', 'aria-label': `最近 14 天共 ${total} 次答题` },
              days.map((day, index) => {
                const height = day.attempts === 0 ? 0 : Math.max(6, Math.round((day.attempts / max) * 100))
                const isToday = index === days.length - 1
                const label = index === 0 ? formatStatsDate(day.date) : index === 7 ? formatStatsDate(day.date) : isToday ? '今天' : ''
                const accuracy = day.accuracy === null ? '暂无' : `${day.accuracy}%`
                const className = `eqz-day-col${isToday ? ' is-today' : ''}${day.attempts === 0 ? ' is-empty' : ''}`
                return h(
                  'div',
                  { key: day.date, className, title: `${day.date}：${day.attempts} 次，正确率 ${accuracy}` },
                  h(
                    'div',
                    { className: 'eqz-day-bar-wrap' },
                    h('div', { className: 'eqz-day-bar', style: { height: `${height}%` } }),
                  ),
                  h('div', { className: 'eqz-day-label' }, label),
                )
              }),
            ),
            h('div', { className: 'eqz-chart-note' }, '柱高为答题次数，最后一根是今天。'),
          ),
      )
    }

    function StatsAnkiFact({ label, value }) {
      return h('div', { className: 'eqz-anki-fact' }, h('dt', null, label), h('dd', null, value))
    }

    function StatsAnki({ anki }) {
      if (anki === null || anki === undefined) {
        return h(
          'section',
          { className: 'eqz-panel eqz-anki' },
          h(
            'div',
            { className: 'eqz-panel-head' },
            h(
              'div',
              null,
              h('div', { className: 'eqz-panel-title' }, 'Anki 复习'),
              h('div', { className: 'eqz-panel-note' }, '还没有导入复习记录'),
            ),
          ),
          h(
            'div',
            { className: 'eqz-note-block' },
            '在对话里说「重新导入 Anki 统计」，或运行 python3 scripts/import-anki-stats.py。',
          ),
        )
      }

      const total = anki.total ?? {}
      const last = anki.last14 ?? {}
      const daily = Array.isArray(anki.daily) ? anki.daily : []
      const decks = Array.isArray(anki.decks) ? anki.decks : []
      const max = Math.max(1, ...daily.map((day) => day.reviews))
      const imported = formatStatsWhen(anki.generatedAt)
      const definition = anki.definition ?? '通过率按非 Again 计算。'
      return h(
        'section',
        { className: 'eqz-panel eqz-anki' },
        h(
          'div',
          { className: 'eqz-panel-head' },
          h(
            'div',
            null,
            h('div', { className: 'eqz-panel-title' }, 'Anki 复习'),
            h(
              'div',
              { className: 'eqz-panel-note' },
              `学习库 ${total.cards ?? 0} 张，累计 ${total.reviews ?? 0} 次`,
            ),
          ),
          total.latestReview
            ? h('div', { className: 'eqz-panel-note' }, `最近复习 ${formatStatsWhen(total.latestReview)}`)
            : null,
        ),
        h(
          'dl',
          { className: 'eqz-anki-stats' },
          h(StatsAnkiFact, { label: '14 天复习', value: `${last.reviews ?? 0} 张` }),
          h(StatsAnkiFact, {
            label: '通过率',
            value: last.accuracy === null || last.accuracy === undefined ? '暂无' : `${last.accuracy}%`,
          }),
          h(StatsAnkiFact, { label: 'Again', value: `${last.again ?? 0} 次` }),
          h(StatsAnkiFact, { label: '学习时长', value: formatStatsDuration(last.minutes) }),
        ),
        daily.length === 0 || (last.reviews ?? 0) === 0
          ? h('div', { className: 'eqz-note-block' }, '最近 14 天没有 Anki 复习记录。')
          : h(
            'div',
            null,
            h(
              'div',
              {
                className: 'eqz-activity eqz-activity-anki',
                role: 'img',
                'aria-label': `最近 14 天 Anki 复习 ${last.reviews} 张`,
              },
              daily.map((day, index) => {
                const height = day.reviews === 0 ? 0 : Math.max(6, Math.round((day.reviews / max) * 100))
                const isToday = index === daily.length - 1
                const label = index === 0 ? formatStatsDate(day.date) : index === 7 ? formatStatsDate(day.date) : isToday ? '今天' : ''
                const className = `eqz-day-col${isToday ? ' is-today' : ''}${day.reviews === 0 ? ' is-empty' : ''}`
                return h(
                  'div',
                  {
                    key: day.date,
                    className,
                    title: `${day.date}：${day.reviews} 张，Again ${day.again}`,
                  },
                  h(
                    'div',
                    { className: 'eqz-day-bar-wrap' },
                    h('div', { className: 'eqz-day-bar', style: { height: `${height}%` } }),
                  ),
                  h('div', { className: 'eqz-day-label' }, label),
                )
              }),
            ),
            h('div', { className: 'eqz-chart-note' }, '柱高为复习张数，最后一根是今天。'),
          ),
        decks.length > 0
          ? h(
            'div',
            { className: 'eqz-anki-decks' },
            h('span', { className: 'eqz-anki-decks-label' }, '主要 deck（近 30 天）'),
            decks.slice(0, 4).map((deck) => h(
              'span',
              {
                key: deck.name,
                className: 'eqz-chip',
                title: `${deck.reviews} 次，通过率 ${deck.accuracy === null || deck.accuracy === undefined ? '暂无' : `${deck.accuracy}%`}`,
              },
              `${deck.name} ${deck.reviews}`,
            )),
          )
          : null,
        h('div', { className: 'eqz-anki-note' }, `${definition}${imported === '' ? '' : ` 导入于 ${imported}。`}`),
      )
    }

    function StatsTable({ points }) {
      return h(
        'section',
        { className: 'eqz-panel' },
        h(
          'div',
          { className: 'eqz-panel-head' },
          h('div', { className: 'eqz-panel-title' }, '考点明细'),
          h('div', { className: 'eqz-panel-note' }, `${points.length} 个考点`),
        ),
        points.length === 0
          ? h('div', { className: 'eqz-note-block' }, '还没有考点记录。')
          : h(
            'div',
            { className: 'eqz-table-wrap' },
            h(
              'table',
              { className: 'eqz-table', 'aria-label': '考点明细' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, '考点'),
                  h('th', null, '状态'),
                  h('th', { className: 'eqz-num' }, '正确率'),
                  h('th', { className: 'eqz-num' }, '答题'),
                  h('th', { className: 'eqz-num' }, '拼写'),
                  h('th', { className: 'eqz-num' }, '最近'),
                ),
              ),
              h(
                'tbody',
                null,
                points.map((point) => {
                  const status = pointStatus(point)
                  return h(
                    'tr',
                    { key: point.point },
                    h('td', { className: 'eqz-col-point', title: point.point }, point.point),
                    h('td', null, h('span', { className: `eqz-chip ${status.className}` }, status.label)),
                    h('td', { className: 'eqz-num' }, point.accuracy === null ? '暂无' : `${point.accuracy}%`),
                    h('td', { className: 'eqz-num' }, point.attempts),
                    h('td', { className: 'eqz-num' }, point.spelling > 0 ? point.spelling : '0'),
                    h('td', { className: 'eqz-num' }, formatStatsDate(point.lastSeen)),
                  )
                }),
              ),
            ),
          ),
      )
    }

    function StatsRecordAnswer({ given, expected, spelling }) {
      return h(
        'div',
        { className: 'eqz-record-answer' },
        h('span', { className: 'eqz-record-label' }, '你填'),
        h('span', { className: spelling ? 'eqz-record-spell' : 'eqz-record-given' }, given === '' ? '未作答' : given),
        h('span', { className: 'eqz-record-label' }, '应为'),
        h('span', { className: 'eqz-record-expected' }, expected === '' ? '暂无' : expected),
      )
    }

    function StatsRecentWrong({ rows }) {
      const list = Array.isArray(rows) ? rows.slice(0, 6) : []
      return h(
        'section',
        { className: 'eqz-bottom-col' },
        h(
          'div',
          { className: 'eqz-panel-head' },
          h('div', { className: 'eqz-panel-title' }, '最近错题'),
          h('div', { className: 'eqz-panel-note' }, list.length === 0 ? '没有记录' : '从新到旧'),
        ),
        list.length === 0
          ? h('div', { className: 'eqz-note-block' }, '最近没有错题。')
          : h(
            'div',
            { className: 'eqz-record' },
            list.map((row, index) => h(
              'div',
              { key: `${row.ts}-${index}`, className: 'eqz-record-item' },
              h(
                'div',
                { className: 'eqz-record-top' },
                h('span', { className: 'eqz-record-point', title: row.point }, row.point),
                row.spelling ? h('span', { className: 'eqz-chip eqz-chip-warn' }, '拼写') : null,
              ),
              row.prompt ? h('div', { className: 'eqz-record-prompt', title: row.prompt }, row.prompt) : null,
              h(StatsRecordAnswer, {
                given: row.given,
                expected: (row.expected ?? [])[0] ?? '',
                spelling: row.spelling === true,
              }),
            )),
          ),
      )
    }

    function StatsSpelling({ rows }) {
      const list = Array.isArray(rows) ? rows.slice(0, 6) : []
      return h(
        'section',
        { className: 'eqz-bottom-col' },
        h(
          'div',
          { className: 'eqz-panel-head' },
          h('div', { className: 'eqz-panel-title' }, '拼写记录'),
          h('div', { className: 'eqz-panel-note' }, '单独计数'),
        ),
        list.length === 0
          ? h('div', { className: 'eqz-note-block' }, '没有拼写记录。')
          : h(
            'div',
            { className: 'eqz-record' },
            list.map((row, index) => h(
              'div',
              { key: `${row.ts}-${index}`, className: 'eqz-record-item' },
              h('div', { className: 'eqz-record-top' }, h('span', { className: 'eqz-record-point' }, row.point)),
              h(StatsRecordAnswer, {
                given: row.given,
                expected: (row.expected ?? [])[0] ?? '',
                spelling: true,
              }),
            )),
          ),
      )
    }

    function StatsSkeleton() {
      return h(
        'div',
        { className: 'eqz-skeleton', 'aria-busy': 'true', 'aria-label': '正在加载统计' },
        h('div', { className: 'eqz-sk eqz-sk-overview' }),
        h(
          'div',
          { className: 'eqz-split' },
          h('div', { className: 'eqz-sk eqz-sk-panel' }),
          h('div', { className: 'eqz-sk eqz-sk-panel' }),
        ),
        h('div', { className: 'eqz-sk eqz-sk-table' }),
      )
    }

    function StatsPage() {
      const [state, setState] = useState({ loading: true, stats: null, error: null })
      const [copyState, setCopyState] = useState('idle')
      const copyTimer = useRef(null)

      const load = useCallback(() => {
        setState((current) => ({ ...current, loading: true, error: null }))
        fetch(STATS_PATH, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((data) => {
            if (data !== null && typeof data === 'object' && data.ok === true) {
              setState({ loading: false, stats: data.stats ?? null, error: null })
            } else {
              setState({ loading: false, stats: null, error: '加载失败' })
            }
          })
          .catch(() => setState({ loading: false, stats: null, error: '加载失败' }))
      }, [])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => () => {
        if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      }, [])

      const stats = state.stats
      const points = Array.isArray(stats?.points) ? stats.points : []
      const weak = points.filter((point) => point.accuracy !== null && point.attempts >= 2 && point.accuracy < 80)
      const focus = weak.slice(0, 3)
      const copyText = focus.length > 0
        ? `练这几个考点：${focus.map((point) => point.point).join('、')}。换新语境，别重复原句。`
        : '换一组混合练习，考点不变，换新语境。'

      const copy = () => {
        const write = navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function'
          ? navigator.clipboard.writeText(copyText)
          : Promise.reject(new Error('clipboard-unavailable'))
        write.then(() => {
          setCopyState('ok')
          if (copyTimer.current !== null) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => setCopyState('idle'), 1800)
        }).catch(() => {
          setCopyState('fail')
          if (copyTimer.current !== null) clearTimeout(copyTimer.current)
          copyTimer.current = setTimeout(() => setCopyState('idle'), 1800)
        })
      }

      const header = h(
        'header',
        { className: 'eqz-stats-head' },
        h(
          'div',
          { className: 'eqz-stats-heading' },
          h('h1', { className: 'eqz-stats-title' }, '英语统计'),
          h('p', { className: 'eqz-stats-sub' }, '练习与复习记录，来自 progress/'),
        ),
        h(
          'div',
          { className: 'eqz-stats-actions' },
          stats?.lastPracticed
            ? h('span', { className: 'eqz-stats-updated' }, `更新于 ${formatStatsWhen(stats.lastPracticed)}`)
            : null,
          h(
            'button',
            { type: 'button', className: 'eqz-sbtn', onClick: load, disabled: state.loading },
            state.loading ? '刷新中…' : '刷新',
          ),
        ),
      )

      const hasAnki = stats !== null && stats.anki !== null && stats.anki !== undefined
      const isEmpty = stats === null || (stats.attempts === 0 && !hasAnki)
      const body = state.loading
        ? h(StatsSkeleton)
        : state.error !== null
          ? h(
            'div',
            { className: 'eqz-empty' },
            h('div', { className: 'eqz-empty-title' }, '统计加载失败'),
            h('div', { className: 'eqz-empty-note' }, '请重试；如果一直失败，检查 DSH 日志。'),
            h('button', { type: 'button', className: 'eqz-sbtn', onClick: load }, '重试'),
          )
          : isEmpty
            ? h(
              'div',
              { className: 'eqz-empty' },
              h('div', { className: 'eqz-empty-title' }, '还没有练习记录'),
              h('div', { className: 'eqz-empty-note' }, '做一组题后，这里会出现正确率、14 天记录和需要练的考点。'),
            )
            : h(
              Fragment,
              null,
              h(StatsOverview, { stats, weakCount: weak.length }),
              h(
                'div',
                { className: 'eqz-split' },
                h(StatsFocus, { focus, copy, copyState }),
                h(StatsActivity, { daily: stats.daily }),
              ),
              h(StatsAnki, { anki: stats.anki }),
              h(StatsTable, { points }),
              h(
                'div',
                { className: 'eqz-bottom' },
                h(StatsRecentWrong, { rows: stats.recentWrong }),
                h(StatsSpelling, { rows: stats.recentSpelling }),
              ),
              h(
                'footer',
                { className: 'eqz-foot' },
                h('p', null, '统计口径：每个填空或翻译项算 1 次；自由表达只记录，不计正确率。'),
                h('p', null, '日志保留最近 2000 条，保存在 progress/quiz-log.jsonl。'),
                h('p', null, 'Anki 复习由 scripts/import-anki-stats.py 导入；通过率按非 Again 计算。'),
              ),
            )

      return h(
        'div',
        { className: 'eqz-stats-page' },
        h('style', null, STATS_STYLE),
        header,
        body,
      )
    }

    function pickEnglishVoice(synth) {
      let voices = []
      try {
        voices = synth.getVoices() ?? []
      } catch {
        return null
      }
      const preferred = voices.find((voice) =>
        /en[-_]US/i.test(voice.lang) && /Samantha|Alex|Google US English|Aria/i.test(voice.name))
      return preferred
        ?? voices.find((voice) => /^en[-_]US/i.test(voice.lang))
        ?? voices.find((voice) => /^en/i.test(voice.lang))
        ?? null
    }

    function speak(text) {
      if (typeof text !== 'string' || text.trim() === '') return
      if (typeof window === 'undefined' || !window.speechSynthesis
        || typeof window.SpeechSynthesisUtterance !== 'function') return
      const synth = window.speechSynthesis
      try {
        synth.cancel()
      } catch {
        // A cancelled queue is allowed to throw on some builds.
      }
      const utterance = new window.SpeechSynthesisUtterance(text)
      utterance.lang = 'en-US'
      utterance.rate = speechRate
      utterance.pitch = 1
      if (speechVoice === null) speechVoice = pickEnglishVoice(synth)
      if (speechVoice !== null) utterance.voice = speechVoice
      try {
        synth.speak(utterance)
      } catch {
        // Speech is a progressive enhancement.
      }
    }

    function stopSpeaking() {
      try {
        window.speechSynthesis?.cancel()
      } catch {
        // Ignore an unavailable speech engine.
      }
    }

    function SpeakerIcon() {
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: 14, height: 14, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M4 9.5v5h3.5L12 18V6L7.5 9.5H4z', fill: 'currentColor' }),
        h('path', {
          d: 'M15.5 8.5a4.5 4.5 0 0 1 0 7',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
        h('path', {
          d: 'M18 6a8 8 0 0 1 0 12',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
        }),
      )
    }

    function SpeakerButton({ text, label }) {
      const disabled = typeof text !== 'string' || text.trim() === ''
      return h(
        'button',
        {
          type: 'button',
          className: 'eqz-speak',
          disabled,
          title: label,
          'aria-label': label,
          onMouseDown: (event) => event.preventDefault(),
          onClick: (event) => {
            event.preventDefault()
            event.stopPropagation()
            speak(text)
          },
        },
        h(SpeakerIcon),
      )
    }

    function speakText(item, values, itemIndex = 0) {
      return (item?.segments ?? []).map((segment) => {
        if (typeof segment === 'string') return segment
        const key = `b${itemIndex}/${segment.blank}`
        const value = values?.[key]
        return typeof value === 'string' && value.trim() !== '' ? value.trim() : ' '
      }).join('')
    }

    function correctText(item, row) {
      const byBlank = new Map((row?.blanks ?? []).map((blank) => [blank.blank, blank]))
      return (item?.segments ?? []).map((segment) => {
        if (typeof segment === 'string') return segment
        const blank = byBlank.get(segment.blank)
        return Array.isArray(blank?.expected) ? blank.expected[0] ?? '' : ''
      }).join('')
    }

    function countWords(text) {
      const matches = String(text).match(/[A-Za-z][A-Za-z'’-]*/g)
      return matches === null ? 0 : matches.length
    }

    function EnglishQuizCard(props) {
      const matched = props.matched
      if (matched === undefined || matched === null) return h(Fragment, null)
      if (matched.phase === 'review') {
        if (matched.quiz?.mode === 'prompt') return h(PromptReviewView, { key: matched.key, matched })
        if (matched.quiz?.mode === 'translate') return h(TranslateReviewView, { key: matched.key, matched })
        return h(ReviewView, { key: matched.key, matched })
      }
      if (matched.quiz?.mode === 'prompt') return h(PromptAnswerView, { key: matched.key, matched })
      if (matched.quiz?.mode === 'translate') return h(TranslateAnswerView, { key: matched.key, matched })
      return h(AnswerView, { key: matched.key, matched })
    }

    function AnswerView({ matched }) {
      const t = translate(matched)
      const quiz = matched.quiz
      const items = quiz.items ?? []
      const mode = quiz.mode === 'passage' ? 'passage' : 'sentences'
      const hasTranslate = items.some((item) => item.kind === 'translate')
      const modeLabel = mode === 'passage' ? '段落' : hasTranslate ? '混合' : '句子'
      const [values, setValues] = useState({})
      const [textValues, setTextValues] = useState({})
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const refs = useRef([])

      useEffect(() => () => stopSpeaking(), [])

      const inputSlots = useMemo(() => {
        const list = []
        items.forEach((item, itemIndex) => {
          if (item.kind === 'translate') {
            list.push({ kind: 'translate', itemId: item.id, itemIndex, key: `t${itemIndex}` })
            return
          }
          for (const segment of item.segments ?? []) {
            if (segment === null || typeof segment !== 'object') continue
            list.push({
              kind: 'blank',
              itemId: item.id,
              itemIndex,
              blankId: segment.blank,
              key: `b${itemIndex}/${segment.blank}`,
            })
          }
        })
        return list
      }, [items])

      const slotIndexByKey = useMemo(
        () => new Map(inputSlots.map((slot, index) => [slot.key, index])),
        [inputSlots],
      )
      const blankCount = inputSlots.filter((slot) => slot.kind === 'blank').length
      const translateCount = inputSlots.length - blankCount

      useEffect(() => {
        const first = refs.current[0]
        if (first !== undefined) first.focus()
      }, [])

      const filled = inputSlots.filter((slot) => (slot.kind === 'translate'
        ? String(textValues[slot.key] ?? '').trim() !== ''
        : String(values[slot.key] ?? '').trim() !== '')).length

      const submit = useCallback(async () => {
        if (sending) return
        setSending(true)
        setError(null)
        try {
          await manager.submit(matched.sessionId, values, textValues)
        } catch {
          setError(t('answer.failed', '提交失败，请重试'))
        } finally {
          setSending(false)
        }
      }, [sending, values, textValues, matched.sessionId, t])

      const onChange = (key) => (event) => {
        const next = event.target.value
        setValues((current) => ({ ...current, [key]: next }))
      }

      const onTextChange = (key) => (event) => {
        const next = event.target.value
        setTextValues((current) => ({ ...current, [key]: next }))
      }

      const onKeyDown = (index) => (event) => {
        if (event.nativeEvent?.isComposing === true) return
        if (event.key !== 'Enter') return
        event.preventDefault()
        if (event.metaKey || event.ctrlKey) {
          void submit()
          return
        }
        const next = refs.current[index + 1]
        if (next !== undefined) next.focus()
        else void submit()
      }

      const countText = mode === 'passage'
        ? `1 段 / ${blankCount} 空`
        : hasTranslate
          ? `${items.length} 项 / ${blankCount} 空 + ${translateCount} 译`
          : `${items.length} 句 / ${blankCount} 空`
      const unit = hasTranslate ? '项' : '空'

      return h(
        Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'eqz-card', role: 'group', 'aria-label': quiz.title ?? t('title', '填空练习') },
          h(
            'div',
            { className: 'eqz-head' },
            h('span', { className: 'eqz-title' }, quiz.title ?? t('title', '填空练习')),
            h('span', { className: 'eqz-mode' }, modeLabel),
            h(
              'span',
              { className: 'eqz-points' },
              (quiz.points ?? []).join(' · '),
            ),
            mode === 'passage'
              ? h(SpeakerButton, { text: speakText(items[0], values, 0), label: '朗读当前段落' })
              : null,
            h(RateControl),
            h('span', { className: 'eqz-count' }, countText),
          ),
          h(
            'div',
            { className: 'eqz-body' },
            items.map((item, itemIndex) => {
              if (item.kind === 'translate') {
                const key = `t${itemIndex}`
                const index = slotIndexByKey.get(key)
                return h(
                  'div',
                  { key: item.id, className: 'eqz-item' },
                  h(
                    'div',
                    { className: 'eqz-line' },
                    h('span', { className: 'eqz-no' }, `${itemIndex + 1}.`),
                    h('span', { className: 'eqz-translate-cn' }, item.prompt ?? ''),
                  ),
                  item.hint ? h('div', { className: 'eqz-trans' }, item.hint) : null,
                  h('input', {
                    ref: (element) => {
                      refs.current[index ?? 0] = element
                    },
                    className: 'eqz-translate-input eqz-translate-inline',
                    type: 'text',
                    value: textValues[key] ?? '',
                    onChange: onTextChange(key),
                    onKeyDown: onKeyDown(index ?? 0),
                    placeholder: '写出英文…',
                    spellCheck: false,
                    autoComplete: 'off',
                    autoCorrect: 'off',
                    autoCapitalize: 'off',
                    enterKeyHint: index === inputSlots.length - 1 ? 'done' : 'next',
                    'aria-label': `第 ${itemIndex + 1} 题，翻译`,
                  }),
                )
              }
              return h(
                'div',
                { key: item.id, className: 'eqz-item' },
                h(
                  'div',
                  { className: 'eqz-line' },
                  mode === 'passage' ? null : h('span', { className: 'eqz-no' }, `${itemIndex + 1}.`),
                  h(
                    'span',
                    { className: mode === 'passage' ? 'eqz-sentence eqz-passage' : 'eqz-sentence' },
                    (item.segments ?? []).map((segment, segmentIndex) => {
                      if (typeof segment === 'string') {
                        return h('span', { key: `s${segmentIndex}` }, segment)
                      }
                      const key = `b${itemIndex}/${segment.blank}`
                      const index = slotIndexByKey.get(key)
                      return h('input', {
                        key: `b${segmentIndex}`,
                        ref: (element) => {
                          refs.current[index ?? 0] = element
                        },
                        className: 'eqz-blank',
                        type: 'text',
                        value: values[key] ?? '',
                        onChange: onChange(key),
                        onKeyDown: onKeyDown(index ?? 0),
                        spellCheck: false,
                        autoComplete: 'off',
                        autoCorrect: 'off',
                        autoCapitalize: 'off',
                        enterKeyHint: index === inputSlots.length - 1 ? 'done' : 'next',
                        'aria-label': `第 ${index === undefined ? 0 : index + 1} 空`,
                        style: { width: `${Math.max(8, Math.min(24, segment.width ?? 10))}ch` },
                      })
                    }),
                  ),
                  mode === 'passage'
                    ? null
                    : h(SpeakerButton, { text: speakText(item, values, itemIndex), label: '朗读当前句子' }),
                ),
                item.translation ? h('div', { className: 'eqz-trans' }, item.translation) : null,
              )
            }),
          ),
          error !== null ? h('div', { className: 'eqz-error' }, error) : null,
          h(
            'div',
            { className: 'eqz-foot' },
            h(
              'span',
              { className: 'eqz-filled' },
              `${t('answer.filled', '已填')} ${filled} / ${inputSlots.length} ${unit}`,
            ),
            h(
              'span',
              { className: 'eqz-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-ghost',
                  onClick: () => {
                    if (manager !== null) manager.dismiss(matched.sessionId)
                  },
                },
                t('answer.cancel', '结束'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-primary',
                  disabled: sending,
                  onClick: () => void submit(),
                },
                sending
                  ? t('answer.sending', '提交中…')
                  : `${t('answer.submit', '提交')} · ${inputSlots.length} ${unit}`,
              ),
            ),
          ),
        ),
      )
    }

    function ReviewView({ matched }) {
      const t = translate(matched)
      const quiz = matched.quiz
      const result = matched.result
      const items = quiz.items ?? []
      const mode = quiz.mode === 'passage' ? 'passage' : 'sentences'
      const hasTranslate = items.some((item) => item.kind === 'translate')
      const modeLabel = mode === 'passage' ? '段落' : hasTranslate ? '混合' : '句子'
      const byItem = new Map((result.items ?? []).map((item) => [item.id, item]))
      const score = result.score ?? { blanks: 0, total: 0, items: 0, itemsCorrect: 0 }
      const wrongCount = (result.items ?? []).reduce((sum, item) => {
        if (item.kind === 'translate') return sum + (item.ok === true ? 0 : 1)
        return sum + (item.blanks ?? []).filter((blank) => !blank.ok).length
      }, 0)
      const passageItem = items[0]
      const passageText = mode === 'passage'
        ? correctText(passageItem, passageItem === undefined ? undefined : byItem.get(passageItem.id))
        : ''

      useEffect(() => () => stopSpeaking(), [])

      const scoreText = hasTranslate
        ? `${score.itemsCorrect} / ${score.items} 项`
        : `${score.blanks} / ${score.totalBlanks ?? score.total} ${t('review.blanks', '空正确')}`

      return h(
        Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'eqz-card eqz-card-review', role: 'group', 'aria-label': '填空练习结果' },
          h(
            'div',
            { className: 'eqz-head' },
            h('span', { className: 'eqz-title' }, t('review.title', '结果')),
            h('span', { className: 'eqz-mode' }, modeLabel),
            h('span', { className: 'eqz-points' }, (quiz.points ?? []).join(' · ')),
            mode === 'passage'
              ? h(SpeakerButton, { text: passageText, label: '朗读正确段落' })
              : null,
            h(RateControl),
            h('span', { className: 'eqz-count eqz-score' }, scoreText),
          ),
          h(
            'div',
            { className: 'eqz-body' },
            items.map((item, itemIndex) => {
              const row = byItem.get(item.id)
              if (item.kind === 'translate') {
                const ok = row?.ok === true
                const reference = Array.isArray(row?.expected) ? row.expected[0] ?? '' : ''
                return h(
                  'div',
                  { key: item.id, className: 'eqz-item' },
                  h(
                    'div',
                    { className: 'eqz-line' },
                    h('span', { className: 'eqz-no' }, `${itemIndex + 1}.`),
                    h('span', { className: 'eqz-translate-cn' }, item.prompt ?? ''),
                    h(SpeakerButton, { text: reference, label: '朗读正确句子' }),
                  ),
                  h('div', { className: 'eqz-label' }, '你的答案'),
                  h(
                    'div',
                    { className: ok ? 'eqz-answer eqz-verdict-ok' : 'eqz-answer eqz-verdict-bad' },
                    row?.given === undefined || row.given === '' ? '—' : row.given,
                  ),
                  ok
                    ? null
                    : h(
                      Fragment,
                      null,
                      h('div', { className: 'eqz-label' }, '参考答案'),
                      h('div', { className: 'eqz-answer eqz-reference' }, reference),
                    ),
                  typeof row?.note === 'string' && row.note !== ''
                    ? h('div', { className: 'eqz-note-line' }, row.note)
                    : null,
                )
              }
              const blanks = row?.blanks ?? []
              const byBlank = new Map(blanks.map((blank) => [blank.blank, blank]))
              const wrongHere = blanks.filter((blank) => !blank.ok)
              return h(
                'div',
                { key: item.id, className: 'eqz-item' },
                h(
                  'div',
                  { className: 'eqz-line' },
                  mode === 'passage' ? null : h('span', { className: 'eqz-no' }, `${itemIndex + 1}.`),
                  h(
                    'span',
                    { className: mode === 'passage' ? 'eqz-sentence eqz-passage' : 'eqz-sentence' },
                    (item.segments ?? []).map((segment, segmentIndex) => {
                      if (typeof segment === 'string') {
                        return h('span', { key: `s${segmentIndex}` }, segment)
                      }
                      const blank = byBlank.get(segment.blank)
                      const ok = blank?.ok === true
                      const spelling = blank?.spelling === true
                      const shown = blank === undefined || blank.given === '' ? '—' : blank.given
                      return h(
                        'span',
                        {
                          key: `b${segmentIndex}`,
                          className: spelling ? 'eqz-spell' : ok ? 'eqz-ok' : 'eqz-bad',
                        },
                        shown,
                      )
                    }),
                  ),
                  mode === 'passage'
                    ? null
                    : h(SpeakerButton, { text: correctText(item, row), label: '朗读正确句子' }),
                ),
                item.translation ? h('div', { className: 'eqz-trans' }, item.translation) : null,
                wrongHere.map((blank) =>
                  h(
                    'div',
                    { key: `w${blank.blank}`, className: blank.spelling ? 'eqz-wrong eqz-spell' : 'eqz-wrong' },
                    `${blank.spelling ? '拼写 · ' : ''}${t('review.yours', '你填')}「${blank.given === '' ? t('review.skipped', '未作答') : blank.given}」`,
                    ` · ${t('review.expected', '应为')}「${(blank.expected ?? [])[0] ?? ''}」`,
                  ),
                ),
                wrongHere.length > 0 && item.note ? h('div', { className: 'eqz-note' }, item.note) : null,
              )
            }),
          ),
          h(
            'div',
            { className: 'eqz-foot' },
            h(
              'span',
              { className: 'eqz-filled' },
              wrongCount === 0
                ? t('review.perfect', '全对，本轮结束。')
                : hasTranslate
                  ? `项全对 ${score.itemsCorrect} / ${score.items} · 空 ${score.blanks} / ${score.totalBlanks} · 译 ${score.translations} / ${score.totalTranslations}`
                  : mode === 'passage'
                    ? `段落全对 ${score.itemsCorrect} / ${score.items} · ${t('review.wrong', '错')} ${wrongCount} 空`
                    : `${t('review.items', '句全对')} ${score.itemsCorrect} / ${score.items} · ${t('review.wrong', '错')} ${wrongCount} 空`,
            ),
            h(
              'span',
              { className: 'eqz-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-ghost',
                  onClick: () => manager?.dismiss(matched.sessionId),
                },
                t('review.done', '结束'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn',
                  onClick: () => manager?.reinforce(matched.sessionId, 'next'),
                },
                t('review.next', '换一组'),
              ),
              wrongCount > 0
                ? h(
                  'button',
                  {
                    type: 'button',
                    className: 'eqz-btn eqz-btn-primary',
                    onClick: () => manager?.reinforce(matched.sessionId, 'reinforce'),
                  },
                  `${t('review.reinforce', '巩固这')} ${wrongCount} ${t('review.reinforceSuffix', '个错点')}`,
                )
                : null,
            ),
          ),
        ),
      )
    }

    function PromptAnswerView({ matched }) {
      const t = translate(matched)
      const quiz = matched.quiz
      const [text, setText] = useState('')
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const inputRef = useRef(null)
      const words = countWords(text)
      const minWords = typeof quiz.minWords === 'number' ? quiz.minWords : 0

      useEffect(() => {
        if (inputRef.current !== null) inputRef.current.focus()
      }, [])
      useEffect(() => () => stopSpeaking(), [])

      const submit = useCallback(async () => {
        if (sending) return
        if (text.trim() === '') {
          setError('先写一点内容再提交')
          return
        }
        setSending(true)
        setError(null)
        try {
          await manager.submitText(matched.sessionId, text)
        } catch {
          setError(t('answer.failed', '提交失败，请重试'))
        } finally {
          setSending(false)
        }
      }, [sending, text, matched.sessionId, t])

      const onKeyDown = (event) => {
        if (event.nativeEvent?.isComposing === true) return
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          void submit()
        }
      }

      return h(
        Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'eqz-card', role: 'group', 'aria-label': quiz.title ?? '自由表达' },
          h(
            'div',
            { className: 'eqz-head' },
            h('span', { className: 'eqz-title' }, quiz.title ?? '自由表达'),
            h('span', { className: 'eqz-mode' }, '自由表达'),
            h('span', { className: 'eqz-points' }, (quiz.points ?? []).join(' · ')),
            h('span', { className: 'eqz-count' }, '1 题'),
          ),
          h(
            'div',
            { className: 'eqz-body' },
            h('div', { className: 'eqz-prompt' }, quiz.prompt ?? ''),
            (quiz.requirements ?? []).length > 0
              ? h(
                'ul',
                { className: 'eqz-reqs' },
                (quiz.requirements ?? []).map((item, index) => h('li', { key: `r${index}` }, item)),
              )
              : null,
            h('textarea', {
              ref: inputRef,
              className: 'eqz-textarea',
              value: text,
              onChange: (event) => setText(event.target.value),
              onKeyDown,
              placeholder: '用英语写在这里…',
              rows: 6,
              spellCheck: false,
              autoComplete: 'off',
              autoCorrect: 'off',
              autoCapitalize: 'off',
              'aria-label': '你的英文回答',
            }),
            h(
              'div',
              { className: 'eqz-wordcount' },
              minWords > 0 ? `${words} words / 建议至少 ${minWords}` : `${words} words`,
            ),
          ),
          error !== null ? h('div', { className: 'eqz-error' }, error) : null,
          h(
            'div',
            { className: 'eqz-foot' },
            h('span', { className: 'eqz-filled' }, '用英语写，Cmd/Ctrl+Enter 提交'),
            h(
              'span',
              { className: 'eqz-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-ghost',
                  onClick: () => manager?.dismiss(matched.sessionId),
                },
                t('answer.cancel', '结束'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-primary',
                  disabled: sending,
                  onClick: () => void submit(),
                },
                sending ? t('answer.sending', '提交中…') : '提交',
              ),
            ),
          ),
        ),
      )
    }

    function PromptReviewView({ matched }) {
      const t = translate(matched)
      const quiz = matched.quiz
      const result = matched.result
      const text = typeof result?.text === 'string' ? result.text : ''
      const words = typeof result?.wordCount === 'number' ? result.wordCount : countWords(text)
      const minWords = typeof quiz.minWords === 'number' ? quiz.minWords : 0

      useEffect(() => () => stopSpeaking(), [])

      return h(
        Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'eqz-card eqz-card-review', role: 'group', 'aria-label': '自由表达结果' },
          h(
            'div',
            { className: 'eqz-head' },
            h('span', { className: 'eqz-title' }, quiz.title ?? '自由表达'),
            h('span', { className: 'eqz-mode' }, '自由表达'),
            h('span', { className: 'eqz-points' }, (quiz.points ?? []).join(' · ')),
            h(SpeakerButton, { text, label: '朗读我的回答' }),
            h(RateControl),
            h('span', { className: 'eqz-count eqz-score' }, `${words} words`),
          ),
          h(
            'div',
            { className: 'eqz-body' },
            h('div', { className: 'eqz-answer' }, text),
            minWords > 0 && words < minWords
              ? h('div', { className: 'eqz-wordcount' }, `建议至少 ${minWords} 词，这次 ${words} 词`)
              : null,
          ),
          h(
            'div',
            { className: 'eqz-foot' },
            h('span', { className: 'eqz-filled' }, '已提交，看聊天里的点评'),
            h(
              'span',
              { className: 'eqz-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-ghost',
                  onClick: () => manager?.dismiss(matched.sessionId),
                },
                t('review.done', '结束'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn',
                  onClick: () => manager?.reinforce(matched.sessionId, 'next'),
                },
                '换一个主题',
              ),
            ),
          ),
        ),
      )
    }

    function TranslateAnswerView({ matched }) {
      const t = translate(matched)
      const quiz = matched.quiz
      const [text, setText] = useState('')
      const [sending, setSending] = useState(false)
      const [error, setError] = useState(null)
      const inputRef = useRef(null)

      useEffect(() => {
        if (inputRef.current !== null) inputRef.current.focus()
      }, [])

      const submit = useCallback(async () => {
        if (sending) return
        if (text.trim() === '') {
          setError('先写出英文再提交')
          return
        }
        setSending(true)
        setError(null)
        try {
          await manager.submitText(matched.sessionId, text)
        } catch {
          setError(t('answer.failed', '提交失败，请重试'))
        } finally {
          setSending(false)
        }
      }, [sending, text, matched.sessionId, t])

      const onKeyDown = (event) => {
        if (event.nativeEvent?.isComposing === true) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void submit()
        }
      }

      return h(
        Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'eqz-card', role: 'group', 'aria-label': quiz.title ?? '中译英' },
          h(
            'div',
            { className: 'eqz-head' },
            h('span', { className: 'eqz-title' }, quiz.title ?? '中译英'),
            h('span', { className: 'eqz-mode' }, '翻译'),
            h('span', { className: 'eqz-points' }, (quiz.points ?? []).join(' · ')),
            h('span', { className: 'eqz-count' }, '1 句'),
          ),
          h(
            'div',
            { className: 'eqz-body' },
            h('div', { className: 'eqz-prompt' }, quiz.prompt ?? ''),
            quiz.hint ? h('div', { className: 'eqz-hint' }, quiz.hint) : null,
            h('input', {
              ref: inputRef,
              className: 'eqz-translate-input',
              type: 'text',
              value: text,
              onChange: (event) => setText(event.target.value),
              onKeyDown,
              placeholder: '写出英文…',
              spellCheck: false,
              autoComplete: 'off',
              autoCorrect: 'off',
              autoCapitalize: 'off',
              'aria-label': '你的英文翻译',
            }),
          ),
          error !== null ? h('div', { className: 'eqz-error' }, error) : null,
          h(
            'div',
            { className: 'eqz-foot' },
            h('span', { className: 'eqz-filled' }, '用英语写出这句，Enter 提交'),
            h(
              'span',
              { className: 'eqz-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-ghost',
                  onClick: () => manager?.dismiss(matched.sessionId),
                },
                t('answer.cancel', '结束'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-primary',
                  disabled: sending,
                  onClick: () => void submit(),
                },
                sending ? t('answer.sending', '提交中…') : '提交',
              ),
            ),
          ),
        ),
      )
    }

    function TranslateReviewView({ matched }) {
      const t = translate(matched)
      const quiz = matched.quiz
      const result = matched.result
      const given = typeof result?.given === 'string' ? result.given : ''
      const expected = Array.isArray(result?.expected) ? result.expected : []
      const reference = expected[0] ?? ''
      const ok = result?.ok === true
      const alternatives = expected.slice(1)

      useEffect(() => () => stopSpeaking(), [])

      return h(
        Fragment,
        null,
        h('style', null, STYLE),
        h(
          'div',
          { className: 'eqz-card eqz-card-review', role: 'group', 'aria-label': '中译英结果' },
          h(
            'div',
            { className: 'eqz-head' },
            h('span', { className: 'eqz-title' }, quiz.title ?? '中译英'),
            h('span', { className: 'eqz-mode' }, '翻译'),
            h('span', { className: 'eqz-points' }, (quiz.points ?? []).join(' · ')),
            h(SpeakerButton, { text: reference, label: '朗读正确句子' }),
            h(RateControl),
            h(
              'span',
              { className: ok ? 'eqz-count eqz-verdict-ok' : 'eqz-count eqz-verdict-bad' },
              ok ? '正确' : '错误',
            ),
          ),
          h(
            'div',
            { className: 'eqz-body' },
            h('div', { className: 'eqz-prompt' }, quiz.prompt ?? ''),
            h('div', { className: 'eqz-label' }, '你的答案'),
            h(
              'div',
              { className: ok ? 'eqz-answer eqz-verdict-ok' : 'eqz-answer eqz-verdict-bad' },
              given === '' ? '—' : given,
            ),
            ok
              ? null
              : h(
                Fragment,
                null,
                h('div', { className: 'eqz-label' }, '参考答案'),
                h('div', { className: 'eqz-answer eqz-reference' }, reference),
                alternatives.length > 0
                  ? h('div', { className: 'eqz-note-line' }, `也可接受：${alternatives.join('；')}`)
                  : null,
              ),
            typeof result?.note === 'string' && result.note !== ''
              ? h('div', { className: 'eqz-note-line' }, result.note)
              : null,
          ),
          h(
            'div',
            { className: 'eqz-foot' },
            h('span', { className: 'eqz-filled' }, '看聊天里的讲解'),
            h(
              'span',
              { className: 'eqz-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn eqz-btn-ghost',
                  onClick: () => manager?.dismiss(matched.sessionId),
                },
                t('review.done', '结束'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'eqz-btn',
                  onClick: () => manager?.reinforce(matched.sessionId, 'next'),
                },
                '换一句',
              ),
            ),
          ),
        ),
      )
    }

    const STYLE = `
.eqz-card{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:12px 16px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.55;text-align:left}
.eqz-head{display:flex;align-items:baseline;gap:10px;margin-bottom:10px;min-width:0}
.eqz-title{font-weight:600;font-size:13px;white-space:nowrap}
.eqz-mode{font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.eqz-speak{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0;flex:none;align-self:center}
.eqz-speak:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}
.eqz-speak:disabled{opacity:.35;cursor:default}
.eqz-speak svg{display:block}
.eqz-rate{display:inline-flex;align-items:center;gap:4px;align-self:center;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}
.eqz-rate select{font:inherit;font-size:12px;height:22px;padding:0 2px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.eqz-points{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.eqz-count{white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px}
.eqz-score{color:var(--dsw-alias-label-primary);font-weight:600;font-size:13px}
.eqz-body{display:flex;flex-direction:column;gap:12px;max-height:44vh;overflow:auto;padding-right:4px}
.eqz-item{display:flex;flex-direction:column;gap:3px}
.eqz-line{display:flex;gap:8px;align-items:flex-start}
.eqz-no{color:var(--dsw-alias-label-secondary);font-size:12px;min-width:18px;padding-top:2px}
.eqz-sentence{flex:1;min-width:0;line-height:2.05}
.eqz-passage{white-space:pre-wrap;line-height:2.1}
.eqz-trans{color:var(--dsw-alias-label-secondary);font-size:12px;padding-left:26px;line-height:1.5}
.eqz-prompt{font-size:14px;line-height:1.7;white-space:pre-wrap}
.eqz-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.eqz-translate-input{box-sizing:border-box;width:100%;height:46px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;line-height:1.5;padding:10px 12px;outline:none}
.eqz-translate-input:focus{border-color:var(--dsw-alias-brand-primary)}
.eqz-translate-cn{flex:1;min-width:0;line-height:1.9}
.eqz-translate-inline{height:auto;min-height:38px;font-size:14px;margin-top:2px}
.eqz-label{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.eqz-reference{color:var(--dsw-alias-state-success-primary)}
.eqz-verdict-ok{color:var(--dsw-alias-state-success-primary);font-weight:600}
.eqz-verdict-bad{color:var(--dsw-alias-state-error-primary);font-weight:600}
.eqz-note-line{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.eqz-reqs{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.7}
.eqz-textarea{box-sizing:border-box;width:100%;min-height:150px;max-height:38vh;resize:vertical;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;line-height:1.7;padding:10px 12px;outline:none}
.eqz-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.eqz-wordcount{color:var(--dsw-alias-label-secondary);font-size:12px;text-align:right}
.eqz-answer{white-space:pre-wrap;line-height:1.75;font-size:14px;background:var(--dsw-alias-bg-layer-2);border-radius:10px;padding:10px 12px}
.eqz-spell{color:var(--dsw-alias-state-warn-primary);font-weight:600}
.eqz-page{box-sizing:border-box;max-width:920px;margin:0 auto;padding:28px 24px 60px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}
.eqz-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}
.eqz-page-title{display:flex;align-items:center;gap:8px;font-size:18px;font-weight:600}
.eqz-page-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:4px}
.eqz-page-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:14px 16px;margin-bottom:14px}
.eqz-page-section{font-size:13px;font-weight:600;margin-bottom:8px}
.eqz-page-wrong{font-size:12px;line-height:1.8;color:var(--dsw-alias-label-secondary);display:flex;gap:6px;flex-wrap:wrap}
.eqz-page-wrong-point{color:var(--dsw-alias-label-primary);font-weight:600}
.eqz-stats-summary{display:flex;gap:18px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:13px;margin-bottom:0}
.eqz-stats-empty{color:var(--dsw-alias-label-secondary);font-size:13px;padding:12px 0}
.eqz-stats-table{width:100%;border-collapse:collapse;font-size:12px}
.eqz-stats-table th,.eqz-stats-table td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.eqz-stats-table th{color:var(--dsw-alias-label-secondary);font-weight:500}
.eqz-stats-section{margin-top:14px}
.eqz-stats-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-bottom:4px}
.eqz-spell-list{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.7}
.eqz-blank{border:none;border-bottom:1.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-weight:600;text-align:center;padding:0 2px 1px;margin:0 3px;outline:none;border-radius:3px;vertical-align:baseline}
.eqz-blank:focus{border-bottom-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}
.eqz-ok{color:var(--dsw-alias-state-success-primary);font-weight:600}
.eqz-bad{color:var(--dsw-alias-state-error-primary);font-weight:600;text-decoration:line-through;text-decoration-thickness:1px}
.eqz-wrong{color:var(--dsw-alias-state-error-primary);font-size:12px;padding-left:26px;line-height:1.6}
.eqz-note{color:var(--dsw-alias-label-secondary);font-size:12px;padding-left:26px;line-height:1.6}
.eqz-error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px}
.eqz-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;flex-wrap:wrap}
.eqz-filled{color:var(--dsw-alias-label-secondary);font-size:12px}
.eqz-actions{display:flex;gap:8px;flex-wrap:wrap}
.eqz-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 12px;font:inherit;font-size:13px;line-height:1.3;cursor:pointer}
.eqz-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.eqz-btn:disabled{opacity:.55;cursor:default}
.eqz-btn-ghost{border-color:transparent;color:var(--dsw-alias-label-secondary)}
.eqz-btn-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:#fff}
.eqz-btn-primary:hover{filter:brightness(1.05)}
`

    // -----------------------------------------------------------------
    // Plugin
    // -----------------------------------------------------------------

    return {
      inject: ['slots', 'sessions', 'uiSession', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'english-quiz: dictionaries')
        const instance = new QuizManager(ctx)
        manager = instance
        instance.start()
        ctx.effect(
          () => () => {
            instance.dispose()
            if (manager === instance) manager = null
          },
          'english-quiz: manager',
        )
        ctx.slots.inject('conversation.composer', () => ctx.slots.register(
          {
            name: 'conversation.composer',
            select: ({ pendingInteraction }) =>
              pendingInteraction !== undefined
                && pendingInteraction !== null
                && pendingInteraction.kind === KIND
                ? pendingInteraction
                : null,
            locale: NS,
          },
          EnglishQuizCard,
        ))
        ctx.slots.inject('conversation.view', () => ctx.slots.register(
          {
            name: 'conversation.view',
            id: 'english-quiz-progress',
            order: 50,
            label: '英语统计',
          },
          StatsPage,
        ))
      },
    }
  },
})
