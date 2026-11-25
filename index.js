/**
 * Host half of dsh-english-quiz.
 *
 * One model-facing tool (`english_quiz`) validates an exercise, publishes the
 * card through a client-visible session projection, and blocks until the
 * browser posts the answer batch to a local route. Grading is deterministic
 * and happens here; the model receives the user's exact answers plus per-blank
 * correctness so it can explain only the wrong ones.
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const name = 'english-quiz'
export const inject = ['tools', 'webServer', 'sessionProjections', 'systemPrompt']

const TOOL_NAME = 'english_quiz'
const PROGRESS_TOOL_NAME = 'english_progress'
const PROJECTION_KEY = 'englishQuiz'
const SUBMIT_PATH = '/plugins/english-quiz/submit'
const STATS_PATH = '/plugins/english-quiz/stats'
const PROGRESS_DIR = 'progress'
const PROGRESS_FILE = 'quiz-log.jsonl'
const MAX_LOG_LINES = 2000
const DEFAULT_TIMEOUT_SEC = 600
const MAX_TIMEOUT_SEC = 3600
const MAX_BODY_BYTES = 64 * 1024
const SENTENCE_MIN_ITEMS = 4
const SENTENCE_MAX_ITEMS = 6
const SENTENCE_MAX_BLANKS_PER_ITEM = 2
const SENTENCE_MAX_TOTAL_BLANKS = 8
const PASSAGE_MIN_BLANKS = 3
const PASSAGE_MAX_BLANKS = 10
const MAX_ANSWERS_PER_BLANK = 4
const SENTENCE_MAX_TEXT_LENGTH = 300
const PASSAGE_MAX_TEXT_LENGTH = 900
const PASSAGE_MAX_TRANSLATION_LENGTH = 600

/** Model guidance so a fresh session reads progress before generating a set. */
const PROMPT_TEXT =
  'English practice: when the user asks to practise English, call english_progress with action "summary" '
  + 'before english_quiz, then choose points from its weakest entries. After a card submission, use the returned '
  + 'wrong items to plan the next set. Do not use these tools for unrelated work.'

/** Live tool calls waiting for their card submission, keyed by call id. */
const pending = new Map()
/** Last workspace seen by a quiz tool call; the stats route reads its log. */
let lastWorkspace
/** Serializes progress-log writes so concurrent submissions cannot interleave. */
let logQueue = Promise.resolve()
/** Cached line counts keyed by log file. */
const logLines = new Map()

export function apply(ctx) {
  ctx.effect(() => ctx.tools.register(toolDefinition()), 'english-quiz: tool')
  ctx.effect(() => ctx.tools.register(progressTool()), 'english-quiz: progress tool')
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: SUBMIT_PATH, handler: submitRoute }),
    'english-quiz: submit route',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: STATS_PATH, handler: statsRoute }),
    'english-quiz: stats route',
  )
  ctx.systemPrompt.section({ name: 'tool:english-quiz', order: 950, text: PROMPT_TEXT })
  ctx.sessionProjections.register(projectionDefinition())
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

function toolDefinition() {
  return {
    name: TOOL_NAME,
    description:
      'Give the user one English practice card, wait for one submission, and return the result. Use it when the '
      + 'user asks to practise English in the chat. Generate the exercise from what the user has already learned: '
      + 'read PROGRESS.md and RECORDED.md first, test only the "已覆盖" grammar points, and include at most one '
      + 'weak point. '
      + 'mode "sentences" (default): 4-6 items; each item is either a blank sentence (segments with 1-2 '
      + 'single-word blanks, a complete Chinese translation, 1-4 accepted answers per blank) or a translation '
      + 'item (`kind:"translate"`, a Chinese `prompt`, and 1-4 accepted English `answers`). Mix both kinds in one '
      + 'set when the user wants translation and fill-in-the-blank practice together. '
      + 'mode "passage": exactly one short paragraph (3-5 sentences, 30-70 words) with 3-10 single-word blanks '
      + 'and one complete Chinese translation; use it when asked for a passage, a short text, or a paragraph. '
      + 'mode "prompt": one open-ended writing topic with no blanks. Provide `prompt` (the Chinese instruction, '
      + 'for example 用英语介绍你自己，并说明你平常工作用什么技术栈), optional `requirements` and `minWords`; the '
      + 'user writes a free paragraph in a large box. Use it when asked to introduce, describe, or write freely. '
      + 'mode "translate": exactly one Chinese sentence in `prompt`, with 1-4 accepted English translations in '
      + '`answers`, optional `hint` and `note`; the user types the whole English sentence in one box. Use it when '
      + 'asked to translate one sentence (中译英). '
      + 'The call returns after submission: for blanks, the exact answers and per-blank correctness (explain only '
      + 'the wrong ones); for prompt, the submitted text and word count (give focused feedback in the chat); for '
      + 'translate, the given sentence plus expected answers and correctness. '
      + 'Never put an answer into the title, translation, hint, note, or prompt.',
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['sentences', 'passage', 'prompt', 'translate'],
          description: 'sentences (default): 4-6 items, blank and/or translation items. passage: one short paragraph. prompt: one open-ended writing topic. translate: one Chinese sentence to translate.',
        },
        prompt: {
          type: 'string',
          description: 'prompt mode: the Chinese topic; translate mode: the Chinese sentence to translate.',
        },
        answers: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 4,
          description: 'translate mode only: accepted English translations; the first is the preferred reference.',
        },
        hint: {
          type: 'string',
          description: 'translate mode only: optional hint shown above the input.',
        },
        note: {
          type: 'string',
          description: 'translate mode only: optional explanation shown with the result.',
        },
        requirements: {
          type: 'array',
          items: { type: 'string' },
          maxItems: 6,
          description: 'prompt mode only: short must-do items, for example ["至少 4 句", "用上 work with"]。',
        },
        minWords: {
          type: 'number',
          description: 'prompt mode only: suggested minimum English word count, 10-300.',
        },
        title: {
          type: 'string',
          description: 'Card title, for example "填空练习". Optional.',
        },
        points: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 8,
          description: 'Grammar or vocabulary points this set tests, for example ["一般过去时", "responsible for"].',
        },
        items: {
          type: 'array',
          minItems: 1,
          maxItems: SENTENCE_MAX_ITEMS,
          description:
            'sentences mode: 4-6 items, each a blank item or a translate item. passage mode: exactly 1 paragraph. '
            + 'Not used in prompt or translate mode. In passage mode, keep all sentences inside one item and use "\\n" between sentences.',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['blank', 'translate'],
                description: 'sentences mode only: defaults to blank; set translate for a Chinese-to-English item.',
              },
              prompt: {
                type: 'string',
                description: 'translate item only: the Chinese sentence to translate.',
              },
              answers: {
                type: 'array',
                items: { type: 'string' },
                minItems: 1,
                maxItems: 4,
                description: 'translate item only: accepted English translations; the first is preferred.',
              },
              hint: {
                type: 'string',
                description: 'translate item only: optional hint.',
              },
              id: {
                type: 'string',
                description: 'Stable id unique within this set, for example "r1-1".',
              },
              point: {
                type: 'string',
                description: 'One label from points.',
              },
              translation: {
                type: 'string',
                description: 'Complete Chinese translation of the sentence, or of the whole paragraph in passage mode.',
              },
              segments: {
                type: 'array',
                description:
                  'Sentence or paragraph split into text strings and blank objects. Example: ["The bug ", '
                  + '{"blank":"b1","answers":["was"]}, " fixed yesterday."]. Use "\\n" inside a string to break '
                  + 'paragraph lines.',
                items: {
                  anyOf: [
                    { type: 'string' },
                    {
                      type: 'object',
                      properties: {
                        blank: { type: 'string', description: 'Blank id unique within the sentence.' },
                        answers: {
                          type: 'array',
                          items: { type: 'string' },
                          minItems: 1,
                          maxItems: MAX_ANSWERS_PER_BLANK,
                          description: 'Accepted answers; the first one is shown as the preferred answer.',
                        },
                        hint: { type: 'string', description: 'Optional hint shown after a wrong answer.' },
                      },
                      required: ['blank', 'answers'],
                    },
                  ],
                },
              },
              note: {
                type: 'string',
                description: 'Optional one-line explanation of the point, shown with a wrong answer.',
              },
            },
            required: ['id', 'point'],
          },
        },
        timeoutSec: {
          type: 'number',
          description: 'How long the card waits before cancelling. Default 600, max 3600.',
        },
      },
      required: ['points'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('english_quiz needs a live agent session')
      const sessionId = agent.session.id
      const workspace = agent.session.header?.cwd
      if (typeof workspace === 'string' && workspace !== '') lastWorkspace = workspace
      for (const entry of pending.values()) {
        if (!entry.done && entry.sessionId === sessionId) {
          throw new Error('A quiz card is already waiting in this session; finish or cancel it first.')
        }
      }
      const set = readSet(args)
      const callId = String(exec.callId)
      const timeoutSec = readTimeout(args)
      if (exec.signal.aborted) return cancelled(set, 'aborted')
      return await new Promise((resolve) => {
        const entry = {
          callId,
          sessionId,
          workspace: typeof workspace === 'string' ? workspace : lastWorkspace,
          set,
          startedAt: Date.now(),
          done: false,
          timer: undefined,
          onAbort: undefined,
          finish(result) {
            if (entry.done) return
            entry.done = true
            if (entry.timer !== undefined) clearTimeout(entry.timer)
            if (entry.onAbort !== undefined) exec.signal.removeEventListener('abort', entry.onAbort)
            pending.delete(callId)
            resolve(result)
          },
        }
        entry.onAbort = () => entry.finish(cancelled(set, 'aborted'))
        exec.signal.addEventListener('abort', entry.onAbort, { once: true })
        entry.timer = setTimeout(() => entry.finish(cancelled(set, 'timeout')), timeoutSec * 1000)
        pending.set(callId, entry)
      })
    },
  }
}

function readTimeout(args) {
  const raw = isRecord(args) ? args.timeoutSec : undefined
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_TIMEOUT_SEC
  return Math.min(MAX_TIMEOUT_SEC, Math.max(30, Math.round(value)))
}

function progressTool() {
  return {
    name: PROGRESS_TOOL_NAME,
    description:
      'Read cross-session English practice progress. Call with action "summary" before the first english_quiz '
      + 'of a session to see weak points, accuracy and recent spelling mistakes; use "wrong" to list recent wrong '
      + 'items for a review set. Do not use it for unrelated work.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['summary', 'wrong'],
          description: 'summary: totals, per-point accuracy and recent spelling errors. wrong: recent wrong items.',
        },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const action = isRecord(args) && args.action === 'wrong' ? 'wrong' : 'summary'
      const workspace = exec.agent?.session?.header?.cwd ?? lastWorkspace
      if (typeof workspace === 'string' && workspace !== '') lastWorkspace = workspace
      if (typeof workspace !== 'string' || workspace === '') return { ok: false, error: 'no-workspace' }
      const records = await readLog(workspace)
      if (action === 'wrong') return { ok: true, items: recentWrong(records) }
      const summary = summarize(records)
      const anki = await readAnkiStats(workspace)
      if (anki !== null) {
        summary.anki = {
          total: anki.total,
          last14: anki.last14,
          last30: anki.last30,
          decks: Array.isArray(anki.decks) ? anki.decks.slice(0, 3) : [],
          generatedAt: anki.generatedAt,
          definition: anki.definition,
        }
      }
      return { ok: true, summary }
    },
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

function readSet(args) {
  if (!isRecord(args)) throw new Error('english_quiz arguments must be an object')
  const mode = args.mode === undefined ? 'sentences' : args.mode
  if (mode !== 'sentences' && mode !== 'passage' && mode !== 'prompt' && mode !== 'translate') {
    throw new Error('mode must be "sentences", "passage", "prompt", or "translate"')
  }
  const points = Array.isArray(args.points)
    ? args.points.filter(nonEmptyString).map((point) => point.trim().slice(0, 60))
    : []
  if (points.length === 0 || points.length > 8) {
    throw new Error('points must list 1-8 non-empty labels')
  }
  const uniquePoints = [...new Set(points)]
  if (mode === 'prompt') return readPromptSet(args, uniquePoints)
  if (mode === 'translate') return readTranslateSet(args, uniquePoints)
  const rawItems = Array.isArray(args.items) ? args.items : []
  const minItems = mode === 'passage' ? 1 : SENTENCE_MIN_ITEMS
  const maxItems = mode === 'passage' ? 1 : SENTENCE_MAX_ITEMS
  const minBlanks = mode === 'passage' ? PASSAGE_MIN_BLANKS : 1
  const maxBlanksPerItem = mode === 'passage' ? PASSAGE_MAX_BLANKS : SENTENCE_MAX_BLANKS_PER_ITEM
  const maxTotalBlanks = mode === 'passage' ? PASSAGE_MAX_BLANKS : SENTENCE_MAX_TOTAL_BLANKS
  const maxText = mode === 'passage' ? PASSAGE_MAX_TEXT_LENGTH : SENTENCE_MAX_TEXT_LENGTH
  const maxTranslation = mode === 'passage' ? PASSAGE_MAX_TRANSLATION_LENGTH : 240
  if (rawItems.length < minItems || rawItems.length > maxItems) {
    const unit = mode === 'passage' ? 'paragraph' : 'sentence'
    throw new Error(`${mode} mode needs ${minItems === maxItems ? minItems : `${minItems}-${maxItems}`} ${unit}(s), got ${rawItems.length}`)
  }
  const seenItemIds = new Set()
  let totalBlanks = 0
  let totalTranslations = 0
  const items = rawItems.map((raw, index) => {
    if (!isRecord(raw)) throw new Error(`items[${index}] must be an object`)
    const id = nonEmptyString(raw.id) ? raw.id.trim().slice(0, 40) : `i${index + 1}`
    if (seenItemIds.has(id)) throw new Error(`items[${index}] repeats id "${id}"`)
    seenItemIds.add(id)
    const point = nonEmptyString(raw.point) ? raw.point.trim().slice(0, 60) : ''
    if (!uniquePoints.includes(point)) {
      throw new Error(`items[${index}].point must be one of points, got ${JSON.stringify(raw.point)}`)
    }
    const kind = mode === 'sentences' && raw.kind === 'translate' ? 'translate' : 'blank'
    if (kind === 'translate') {
      const prompt = nonEmptyString(raw.prompt) ? raw.prompt.trim().slice(0, 300) : ''
      if (prompt === '') throw new Error(`items[${index}].prompt is required for a translate item`)
      const answers = Array.isArray(raw.answers)
        ? raw.answers.filter(nonEmptyString).map((answer) => answer.trim().slice(0, 300))
        : []
      if (answers.length === 0) throw new Error(`items[${index}].answers is required for a translate item`)
      if (answers.length > MAX_ANSWERS_PER_BLANK) {
        throw new Error(`items[${index}].answers accepts at most ${MAX_ANSWERS_PER_BLANK}`)
      }
      const hint = nonEmptyString(raw.hint) ? raw.hint.trim().slice(0, 160) : undefined
      const note = nonEmptyString(raw.note) ? raw.note.trim().slice(0, 200) : undefined
      totalTranslations += 1
      return {
        kind: 'translate',
        id,
        point,
        prompt,
        answers: [...new Set(answers)],
        ...(hint === undefined ? {} : { hint }),
        ...(note === undefined ? {} : { note }),
      }
    }
    const translation = nonEmptyString(raw.translation) ? raw.translation.trim().slice(0, maxTranslation) : ''
    if (translation === '') throw new Error(`items[${index}].translation is required`)
    const rawSegments = Array.isArray(raw.segments) ? raw.segments : []
    if (rawSegments.length === 0) throw new Error(`items[${index}].segments is required`)
    const seenBlankIds = new Set()
    let itemBlanks = 0
    let previousWasBlank = false
    let textLength = 0
    const segments = rawSegments.map((segment, segmentIndex) => {
      if (typeof segment === 'string') {
        textLength += segment.length
        previousWasBlank = false
        return segment
      }
      if (!isRecord(segment)) {
        throw new Error(`items[${index}].segments[${segmentIndex}] must be a string or a blank object`)
      }
      if (previousWasBlank) throw new Error(`items[${index}] has two adjacent blanks`)
      const blank = nonEmptyString(segment.blank) ? segment.blank.trim().slice(0, 40) : `b${itemBlanks + 1}`
      if (seenBlankIds.has(blank)) throw new Error(`items[${index}] repeats blank "${blank}"`)
      seenBlankIds.add(blank)
      const answers = Array.isArray(segment.answers)
        ? segment.answers.filter(nonEmptyString).map((answer) => answer.trim().slice(0, 120))
        : []
      if (answers.length === 0) throw new Error(`items[${index}].segments[${segmentIndex}].answers is required`)
      if (answers.length > MAX_ANSWERS_PER_BLANK) {
        throw new Error(`items[${index}].segments[${segmentIndex}].answers accepts at most ${MAX_ANSWERS_PER_BLANK}`)
      }
      const hint = nonEmptyString(segment.hint) ? segment.hint.trim().slice(0, 120) : undefined
      itemBlanks += 1
      previousWasBlank = true
      return { blank, answers: [...new Set(answers)], ...(hint === undefined ? {} : { hint }) }
    })
    if (itemBlanks < minBlanks || itemBlanks > maxBlanksPerItem) {
      throw new Error(`items[${index}] must have ${minBlanks}-${maxBlanksPerItem} blanks, got ${itemBlanks}`)
    }
    if (textLength > maxText) {
      throw new Error(`items[${index}] is longer than ${maxText} characters`)
    }
    totalBlanks += itemBlanks
    const note = nonEmptyString(raw.note) ? raw.note.trim().slice(0, 160) : undefined
    return {
      kind: 'blank',
      id,
      point,
      translation,
      segments,
      ...(note === undefined ? {} : { note }),
    }
  })
  if (totalBlanks > maxTotalBlanks) {
    throw new Error(`a card accepts at most ${maxTotalBlanks} blanks in ${mode} mode, got ${totalBlanks}`)
  }
  return {
    setId: `eq-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    title: nonEmptyString(args.title)
      ? args.title.trim().slice(0, 80)
      : mode === 'passage' ? '段落填空' : '填空练习',
    mode,
    points: uniquePoints,
    items,
    totalBlanks,
    totalTranslations,
  }
}

function readPromptSet(args, points) {
  const prompt = nonEmptyString(args.prompt) ? args.prompt.trim().slice(0, 600) : ''
  if (prompt === '') throw new Error('prompt mode needs a non-empty `prompt` topic')
  const requirements = Array.isArray(args.requirements)
    ? args.requirements.filter(nonEmptyString).map((item) => item.trim().slice(0, 120)).slice(0, 6)
    : []
  const rawMin = typeof args.minWords === 'number' && Number.isFinite(args.minWords) ? Math.round(args.minWords) : 0
  const minWords = rawMin > 0 ? Math.min(300, Math.max(10, rawMin)) : 0
  return {
    setId: `eq-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    title: nonEmptyString(args.title) ? args.title.trim().slice(0, 80) : '自由表达',
    mode: 'prompt',
    points,
    prompt,
    requirements,
    minWords,
    items: [],
    totalBlanks: 0,
  }
}

function readTranslateSet(args, points) {
  const prompt = nonEmptyString(args.prompt) ? args.prompt.trim().slice(0, 300) : ''
  if (prompt === '') throw new Error('translate mode needs a non-empty `prompt` sentence')
  const answers = Array.isArray(args.answers)
    ? args.answers.filter(nonEmptyString).map((answer) => answer.trim().slice(0, 300))
    : []
  if (answers.length === 0) throw new Error('translate mode needs at least one accepted answer')
  if (answers.length > 4) throw new Error('translate mode accepts at most 4 answers')
  const hint = nonEmptyString(args.hint) ? args.hint.trim().slice(0, 160) : undefined
  const note = nonEmptyString(args.note) ? args.note.trim().slice(0, 200) : undefined
  return {
    setId: `eq-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    title: nonEmptyString(args.title) ? args.title.trim().slice(0, 80) : '中译英',
    mode: 'translate',
    points,
    prompt,
    answers: [...new Set(answers)],
    ...(hint === undefined ? {} : { hint }),
    ...(note === undefined ? {} : { note }),
    items: [],
    totalBlanks: 1,
  }
}

function countWords(text) {
  const matches = String(text).match(/[A-Za-z][A-Za-z'’-]*/g)
  return matches === null ? 0 : matches.length
}

// ---------------------------------------------------------------------------
// Grading
// ---------------------------------------------------------------------------

const CONTRACTIONS = {
  "i'm": 'i am',
  "you're": 'you are',
  "he's": 'he is',
  "she's": 'she is',
  "it's": 'it is',
  "we're": 'we are',
  "they're": 'they are',
  "i've": 'i have',
  "you've": 'you have',
  "we've": 'we have',
  "they've": 'they have',
  "i'll": 'i will',
  "you'll": 'you will',
  "he'll": 'he will',
  "she'll": 'she will',
  "it'll": 'it will',
  "we'll": 'we will',
  "they'll": 'they will',
  "i'd": 'i would',
  "you'd": 'you would',
  "he'd": 'he would',
  "she'd": 'she would',
  "we'd": 'we would',
  "they'd": 'they would',
  "don't": 'do not',
  "doesn't": 'does not',
  "didn't": 'did not',
  "isn't": 'is not',
  "aren't": 'are not',
  "wasn't": 'was not',
  "weren't": 'were not',
  "haven't": 'have not',
  "hasn't": 'has not',
  "hadn't": 'had not',
  "won't": 'will not',
  "wouldn't": 'would not',
  "can't": 'cannot',
  "couldn't": 'could not',
  "shouldn't": 'should not',
  "mustn't": 'must not',
}

const CONTRACTION_PATTERN = new RegExp(`\\b(${Object.keys(CONTRACTIONS).map(escapeRegExp).join('|')})\\b`, 'g')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Comparison form of one answer: compatibility-normalized, quote-normalized,
 * whitespace-collapsed, lowercased, trailing punctuation removed, and
 * contractions expanded. Display still uses the raw answer.
 * @param {string} value
 * @returns {string}
 */
function normalizeAnswer(value) {
  let text = String(value ?? '')
  text = text.normalize('NFKC')
  text = text.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"')
  text = text.replace(/\s+/g, ' ').trim().toLowerCase()
  text = text.replace(/[.,!?;:]+$/g, '').trim()
  text = text.replace(CONTRACTION_PATTERN, (match) => CONTRACTIONS[match] ?? match)
  return text.replace(/\s+/g, ' ').trim()
}

function readBatch(set, answers, translations) {
  if (!Array.isArray(answers)) return null
  const provided = new Map()
  for (const raw of answers) {
    if (!isRecord(raw)) return null
    const itemId = typeof raw.itemId === 'string' ? raw.itemId : ''
    const blankId = typeof raw.blankId === 'string' ? raw.blankId : ''
    const given = typeof raw.given === 'string' ? raw.given.slice(0, 200) : ''
    const key = `${itemId}/${blankId}`
    if (provided.has(key)) return null
    provided.set(key, given)
  }
  const translated = new Map()
  const rawTranslations = Array.isArray(translations) ? translations : []
  for (const raw of rawTranslations) {
    if (!isRecord(raw)) return null
    const itemId = typeof raw.itemId === 'string' ? raw.itemId : ''
    if (translated.has(itemId)) return null
    translated.set(itemId, typeof raw.text === 'string' ? raw.text.slice(0, 500) : '')
  }
  for (const item of set.items) {
    if (item.kind === 'translate') {
      if (!translated.has(item.id)) return null
      continue
    }
    for (const segment of item.segments) {
      if (isRecord(segment) && !provided.has(`${item.id}/${segment.blank}`)) return null
    }
  }
  return { provided, translated }
}

function grade(set, batch, durationMs) {
  const { provided, translated } = batch
  const perPoint = new Map(set.points.map((point) => [point, { point, ok: 0, total: 0, skipped: 0 }]))
  let blanksCorrect = 0
  let blanksTotal = 0
  let skipped = 0
  let translationsCorrect = 0
  let translationsTotal = 0
  let itemsCorrect = 0
  const items = set.items.map((item) => {
    if (item.kind === 'translate') {
      const given = (translated.get(item.id) ?? '').trim()
      const normalized = normalizeAnswer(given)
      const ok = normalized !== '' && item.answers.some((answer) => normalizeAnswer(answer) === normalized)
      translationsTotal += 1
      if (ok) translationsCorrect += 1
      if (ok) itemsCorrect += 1
      const row = perPoint.get(item.point)
      if (row !== undefined) {
        row.total += 1
        if (ok) row.ok += 1
      }
      return {
        kind: 'translate',
        id: item.id,
        point: item.point,
        prompt: item.prompt,
        given,
        expected: item.answers,
        ok,
        spelling: false,
        ...(item.note === undefined ? {} : { note: item.note }),
      }
    }
    const blanks = []
    for (const segment of item.segments) {
      if (!isRecord(segment)) continue
      const given = (provided.get(`${item.id}/${segment.blank}`) ?? '').trim()
      const normalized = normalizeAnswer(given)
      const ok = normalized !== '' && segment.answers.some((answer) => normalizeAnswer(answer) === normalized)
      const isSkipped = given === ''
      const spelling = !ok && looksLikeSpelling(given, segment.answers)
      blanks.push({
        blank: segment.blank,
        given,
        expected: segment.answers,
        ok,
        skipped: isSkipped,
        spelling,
      })
      const row = perPoint.get(item.point)
      if (row !== undefined) {
        row.total += 1
        if (ok) row.ok += 1
        if (isSkipped) row.skipped += 1
      }
      blanksTotal += 1
      if (ok) blanksCorrect += 1
      if (isSkipped) skipped += 1
    }
    const itemOk = blanks.length > 0 && blanks.every((blank) => blank.ok)
    if (itemOk) itemsCorrect += 1
    return { kind: 'blank', id: item.id, point: item.point, ok: itemOk, blanks }
  })
  return {
    setId: set.setId,
    status: 'submitted',
    mode: set.mode,
    score: {
      items: items.length,
      itemsCorrect,
      blanks: blanksCorrect,
      total: blanksTotal,
      totalBlanks: blanksTotal,
      translations: translationsCorrect,
      totalTranslations: translationsTotal,
      skipped,
    },
    perPoint: [...perPoint.values()],
    items,
    durationMs,
  }
}

function cancelled(set, reason) {
  return { setId: set.setId, status: 'cancelled', mode: set.mode, reason }
}

// ---------------------------------------------------------------------------
// Progress log
// ---------------------------------------------------------------------------

function progressFile(workspace) {
  return join(workspace, PROGRESS_DIR, PROGRESS_FILE)
}

async function countLines(file) {
  try {
    const text = await readFile(file, 'utf8')
    return text.split('\n').filter((line) => line !== '').length
  } catch {
    return 0
  }
}

async function readLog(workspace) {
  try {
    const text = await readFile(progressFile(workspace), 'utf8')
    const records = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const record = JSON.parse(line)
        if (isRecord(record)) records.push(record)
      } catch {
        // A torn last line is ignored; the next write keeps the log usable.
      }
    }
    return records
  } catch {
    return []
  }
}

async function readAnkiStats(workspace) {
  try {
    const text = await readFile(join(workspace, PROGRESS_DIR, 'anki-stats.json'), 'utf8')
    const data = JSON.parse(text)
    return isRecord(data) ? data : null
  } catch {
    return null
  }
}

async function appendLog(workspace, records) {
  if (typeof workspace !== 'string' || workspace === '' || records.length === 0) return
  const file = progressFile(workspace)
  logQueue = logQueue.then(async () => {
    await mkdir(join(workspace, PROGRESS_DIR), { recursive: true })
    await appendFile(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8')
    let lines = logLines.get(file)
    if (lines === undefined) lines = await countLines(file)
    lines += records.length
    if (lines > MAX_LOG_LINES) {
      const rows = await readLog(workspace)
      const kept = rows.slice(-MAX_LOG_LINES)
      await writeFile(file, kept.length === 0 ? '' : kept.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
      lines = kept.length
    }
    logLines.set(file, lines)
  }).catch(() => {})
  await logQueue
}

function recordOf(record) {
  return {
    ts: record.ts,
    mode: record.mode,
    kind: record.kind,
    point: record.point,
    prompt: record.prompt,
    given: record.given,
    expected: record.expected,
    ok: record.ok,
    spelling: record.spelling === true,
    ...(record.wordCount === undefined ? {} : { wordCount: record.wordCount }),
  }
}

function recentWrong(records) {
  return records
    .filter((record) => record.ok === false)
    .slice(-20)
    .reverse()
    .map(recordOf)
}

function localDayKey(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const pad = (part) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function buildDaily(records) {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const days = []
  const byDay = new Map()
  for (let offset = 13; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(date.getDate() - offset)
    const dateKey = localDayKey(date)
    const row = { date: dateKey, attempts: 0, scored: 0, correct: 0, spelling: 0 }
    days.push(row)
    byDay.set(dateKey, row)
  }
  for (const record of records) {
    if (typeof record.ts !== 'string') continue
    const row = byDay.get(localDayKey(record.ts))
    if (row === undefined) continue
    row.attempts += 1
    if (record.ok === true || record.ok === false) row.scored += 1
    if (record.ok === true) row.correct += 1
    if (record.spelling === true) row.spelling += 1
  }
  return days.map((row) => ({
    ...row,
    accuracy: row.scored === 0 ? null : Math.round((row.correct / row.scored) * 100),
  }))
}

function activeDaysOf(records) {
  const days = new Set()
  for (const record of records) {
    if (typeof record.ts !== 'string') continue
    const key = localDayKey(record.ts)
    if (key !== null) days.add(key)
  }
  return days
}

function streakOf(active) {
  if (active.size === 0) return 0
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  if (!active.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (active.has(localDayKey(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

function summarize(records) {
  const scored = records.filter((record) => record.ok === true || record.ok === false)
  const correct = scored.filter((record) => record.ok === true).length
  const spelling = records.filter((record) => record.spelling === true).length
  const modes = {}
  const points = new Map()
  const setIds = new Set()
  let lastPracticed = null
  let firstPracticed = null
  for (const record of records) {
    if (typeof record.mode === 'string') modes[record.mode] = (modes[record.mode] ?? 0) + 1
    if (typeof record.setId === 'string' && record.setId !== '') setIds.add(record.setId)
    if (typeof record.ts === 'string' && (lastPracticed === null || record.ts > lastPracticed)) {
      lastPracticed = record.ts
    }
    if (typeof record.ts === 'string' && (firstPracticed === null || record.ts < firstPracticed)) {
      firstPracticed = record.ts
    }
    const point = typeof record.point === 'string' && record.point !== '' ? record.point : '未分类'
    const row = points.get(point) ?? {
      point,
      attempts: 0,
      scored: 0,
      correct: 0,
      spelling: 0,
      lastSeen: null,
    }
    row.attempts += 1
    if (record.ok === true || record.ok === false) row.scored += 1
    if (record.ok === true) row.correct += 1
    if (record.spelling === true) row.spelling += 1
    if (typeof record.ts === 'string' && (row.lastSeen === null || record.ts > row.lastSeen)) {
      row.lastSeen = record.ts
    }
    points.set(point, row)
  }
  const list = [...points.values()]
    .map((row) => ({
      ...row,
      accuracy: row.scored === 0 ? null : Math.round((row.correct / row.scored) * 100),
    }))
    .sort((left, right) => {
      const a = left.accuracy === null ? 101 : left.accuracy
      const b = right.accuracy === null ? 101 : right.accuracy
      return a - b || right.attempts - left.attempts
    })
  const active = activeDaysOf(records)
  return {
    attempts: records.length,
    scored: scored.length,
    correct,
    accuracy: scored.length === 0 ? null : Math.round((correct / scored.length) * 100),
    spelling,
    sets: setIds.size,
    activeDays: active.size,
    streak: streakOf(active),
    firstPracticed,
    lastPracticed,
    modes,
    points: list,
    daily: buildDaily(records),
    recentSpelling: records
      .filter((record) => record.spelling === true)
      .slice(-8)
      .reverse()
      .map(recordOf),
    recentWrong: recentWrong(records).slice(0, 10),
  }
}

function sentenceOf(item) {
  return (item.segments ?? []).map((segment) => (typeof segment === 'string' ? segment : '___')).join('')
}

function recordsFromResult(entry, result) {
  const ts = new Date().toISOString()
  const base = { ts, sessionId: entry.sessionId, setId: result.setId, mode: result.mode }
  if (result.mode === 'prompt') {
    return [{
      ...base,
      kind: 'prompt',
      point: entry.set.points[0] ?? '自由表达',
      prompt: entry.set.prompt,
      given: result.text,
      expected: [],
      ok: null,
      spelling: false,
      wordCount: result.wordCount,
    }]
  }
  if (result.mode === 'translate') {
    return [{
      ...base,
      kind: 'translate',
      point: entry.set.points[0] ?? '翻译',
      prompt: entry.set.prompt,
      given: result.given,
      expected: result.expected,
      ok: result.ok,
      spelling: false,
    }]
  }
  const sourceById = new Map((entry.set.items ?? []).map((item) => [item.id, item]))
  const records = []
  for (const item of result.items ?? []) {
    if (item.kind === 'translate') {
      records.push({
        ...base,
        kind: 'translate',
        point: item.point,
        prompt: item.prompt,
        given: item.given,
        expected: item.expected,
        ok: item.ok,
        spelling: false,
      })
      continue
    }
    const source = sourceById.get(item.id)
    const prompt = source === undefined ? '' : sentenceOf(source)
    for (const blank of item.blanks ?? []) {
      records.push({
        ...base,
        kind: 'blank',
        point: item.point,
        prompt,
        given: blank.given,
        expected: blank.expected,
        ok: blank.ok,
        spelling: blank.spelling === true,
      })
    }
  }
  return records
}

function looksLikeSpelling(given, answers) {
  const value = normalizeAnswer(given)
  if (value.length < 5 || !/^[a-z]+$/.test(value)) return false
  for (const answer of answers) {
    const target = normalizeAnswer(answer)
    if (target.length < 5 || !/^[a-z]+$/.test(target)) continue
    if (Math.abs(target.length - value.length) > 2) continue
    const distance = damerauLevenshtein(value, target)
    if (distance > 0 && distance <= (target.length >= 8 ? 2 : 1)) return true
  }
  return false
}

function damerauLevenshtein(left, right) {
  const rows = left.length + 1
  const columns = right.length + 1
  const distances = Array.from({ length: rows }, () => new Array(columns).fill(0))
  for (let row = 0; row < rows; row += 1) distances[row][0] = row
  for (let column = 0; column < columns; column += 1) distances[0][column] = column
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      distances[row][column] = Math.min(
        distances[row - 1][column] + 1,
        distances[row][column - 1] + 1,
        distances[row - 1][column - 1] + cost,
      )
      if (row > 1 && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]) {
        distances[row][column] = Math.min(distances[row][column], distances[row - 2][column - 2] + 1)
      }
    }
  }
  return distances[left.length][right.length]
}

async function statsRoute(req, res) {
  const send = (status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'GET') {
    send(405, { ok: false, error: 'method-not-allowed' })
    return
  }
  if (typeof lastWorkspace !== 'string' || lastWorkspace === '') {
    send(200, { ok: true, stats: null })
    return
  }
  const records = await readLog(lastWorkspace)
  const stats = summarize(records)
  stats.anki = await readAnkiStats(lastWorkspace)
  send(200, { ok: true, stats })
}

// ---------------------------------------------------------------------------
// Submit route
// ---------------------------------------------------------------------------

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) return { tooLarge: true }
    chunks.push(chunk)
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch {
    return { value: undefined }
  }
}

async function submitRoute(req, res) {
  const send = (status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(JSON.stringify(body))
  }
  if (req.method !== 'POST') {
    send(405, { ok: false, error: 'method-not-allowed' })
    return
  }
  const read = await readJson(req)
  if (read.tooLarge) {
    send(413, { ok: false, error: 'body-too-large' })
    return
  }
  const body = read.value
  if (!isRecord(body) || typeof body.callId !== 'string') {
    send(400, { ok: false, error: 'bad-request' })
    return
  }
  const entry = pending.get(body.callId)
  if (entry === undefined || entry.done) {
    send(409, { ok: false, error: 'expired' })
    return
  }
  if (body.cancel === true) {
    entry.finish(cancelled(entry.set, 'user'))
    send(200, { ok: true, cancelled: true })
    return
  }
  if (entry.set.mode === 'prompt') {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 5000) : ''
    if (text === '') {
      send(400, { ok: false, error: 'empty-answer' })
      return
    }
    const result = {
      setId: entry.set.setId,
      status: 'submitted',
      mode: 'prompt',
      text,
      wordCount: countWords(text),
      durationMs: Date.now() - entry.startedAt,
    }
    await appendLog(entry.workspace, recordsFromResult(entry, result))
    entry.finish(result)
    send(200, { ok: true, result })
    return
  }
  if (entry.set.mode === 'translate') {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : ''
    if (text === '') {
      send(400, { ok: false, error: 'empty-answer' })
      return
    }
    const normalized = normalizeAnswer(text)
    const ok = entry.set.answers.some((answer) => normalizeAnswer(answer) === normalized)
    const result = {
      setId: entry.set.setId,
      status: 'submitted',
      mode: 'translate',
      prompt: entry.set.prompt,
      given: text,
      expected: entry.set.answers,
      ok,
      ...(entry.set.note === undefined ? {} : { note: entry.set.note }),
      durationMs: Date.now() - entry.startedAt,
    }
    await appendLog(entry.workspace, recordsFromResult(entry, result))
    entry.finish(result)
    send(200, { ok: true, result })
    return
  }
  const provided = readBatch(entry.set, body.answers, body.translations)
  if (provided === null) {
    send(400, { ok: false, error: 'bad-answers' })
    return
  }
  const result = grade(entry.set, provided, Date.now() - entry.startedAt)
  await appendLog(entry.workspace, recordsFromResult(entry, result))
  entry.finish(result)
  send(200, { ok: true, result })
}

// ---------------------------------------------------------------------------
// Client card projection
// ---------------------------------------------------------------------------

function passthroughSchema() {
  return {
    parse(value) {
      return value
    },
  }
}

function projectionDefinition() {
  return {
    key: PROJECTION_KEY,
    stateVersion: 1,
    stateSchema: passthroughSchema(),
    init: () => ({ pending: null }),
    apply(state, event) {
      if (event.type === 'tool/call') {
        const data = event.data
        if (data.name !== TOOL_NAME) return state
        const card = cardViewOf(data.arguments)
        if (card === null) return state
        return { pending: { ...card, callId: data.callId } }
      }
      if (event.type === 'tool/result') {
        const current = state.pending
        if (current === null || current === undefined) return state
        if (event.data.message.toolCallId !== current.callId) return state
        return { pending: null }
      }
      return state
    },
    wire: {
      viewSchema: passthroughSchema(),
      view: (state) => state,
    },
  }
}

/**
 * Strip answers out of the recorded tool arguments for the browser card.
 * Returns null when the arguments are not a usable exercise.
 * @param {string} argumentsText
 */
function cardViewOf(argumentsText) {
  let args
  try {
    args = JSON.parse(argumentsText)
  } catch {
    return null
  }
  if (!isRecord(args)) return null
  const points = Array.isArray(args.points) ? args.points.filter(nonEmptyString).map((point) => String(point)) : []
  if (args.mode === 'prompt') {
    if (!nonEmptyString(args.prompt)) return null
    const requirements = Array.isArray(args.requirements)
      ? args.requirements.filter(nonEmptyString).map((item) => String(item)).slice(0, 6)
      : []
    const rawMin = typeof args.minWords === 'number' && Number.isFinite(args.minWords) ? Math.round(args.minWords) : 0
    return {
      title: nonEmptyString(args.title) ? String(args.title) : '自由表达',
      mode: 'prompt',
      points,
      prompt: String(args.prompt).slice(0, 600),
      requirements,
      minWords: rawMin > 0 ? Math.min(300, Math.max(10, rawMin)) : 0,
    }
  }
  if (args.mode === 'translate') {
    if (!nonEmptyString(args.prompt) || !Array.isArray(args.answers)) return null
    return {
      title: nonEmptyString(args.title) ? String(args.title) : '中译英',
      mode: 'translate',
      points,
      prompt: String(args.prompt).slice(0, 300),
      ...(nonEmptyString(args.hint) ? { hint: String(args.hint).slice(0, 160) } : {}),
    }
  }
  if (!Array.isArray(args.items) || args.items.length === 0) return null
  const items = []
  let totalBlanks = 0
  let totalTranslations = 0
  let rawIndex = 0
  for (const raw of args.items) {
    if (!isRecord(raw)) return null
    const itemIndex = rawIndex
    rawIndex += 1
    const itemId = nonEmptyString(raw.id) ? String(raw.id).trim().slice(0, 40) : `i${itemIndex + 1}`
    if (args.mode !== 'passage' && raw.kind === 'translate') {
      if (!nonEmptyString(raw.prompt) || !Array.isArray(raw.answers)) return null
      items.push({
        kind: 'translate',
        id: itemId,
        point: String(raw.point ?? '').trim(),
        prompt: String(raw.prompt).slice(0, 300),
        ...(nonEmptyString(raw.hint) ? { hint: String(raw.hint).slice(0, 160) } : {}),
      })
      totalTranslations += 1
      continue
    }
    if (!Array.isArray(raw.segments)) return null
    const segments = []
    let itemBlanks = 0
    for (const segment of raw.segments) {
      if (typeof segment === 'string') {
        segments.push(segment)
        continue
      }
      if (!isRecord(segment) || !Array.isArray(segment.answers)) return null
      const first = segment.answers.find(nonEmptyString)
      const width = Math.min(24, Math.max(8, (first === undefined ? 8 : String(first).length) + 2))
      const blankId = nonEmptyString(segment.blank)
        ? String(segment.blank).trim().slice(0, 40)
        : `b${itemBlanks + 1}`
      segments.push({
        blank: blankId,
        ...(nonEmptyString(segment.hint) ? { hint: String(segment.hint) } : {}),
        width,
      })
      itemBlanks += 1
      totalBlanks += 1
    }
    items.push({
      kind: 'blank',
      id: itemId,
      point: String(raw.point ?? '').trim(),
      translation: String(raw.translation ?? ''),
      segments,
      ...(nonEmptyString(raw.note) ? { note: String(raw.note) } : {}),
    })
  }
  return {
    title: nonEmptyString(args.title) ? String(args.title) : args.mode === 'passage' ? '段落填空' : '填空练习',
    mode: args.mode === 'passage' ? 'passage' : 'sentences',
    points,
    items,
    totalBlanks,
    totalTranslations,
  }
}
