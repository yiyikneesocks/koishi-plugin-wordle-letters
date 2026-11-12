import { Context, Schema } from 'koishi'
import { join, resolve } from 'path'
import { } from '@koishijs/plugin-console'
import fs from 'fs'
import { } from 'koishi-plugin-puppeteer'

export const name = 'wordle-letters'
export const inject = { optional: ['puppeteer'] }

export interface Config {
  // 猜词库（答案来源）：每行「单词 [含义]」，取行首空格前的单词
  answerDict?: string
  // 合法词库（判定猜测是否有效）：每行一个单词
  guessDict?: string
  // 简单词库（常用/易猜词，如 and/aim/art/among/direct/digital）
  easyDict?: string
  // 最大猜测次数
  maxGuesses?: number
  // 允许的单词长度范围（可小到 2，大到十几个字母）
  minLength?: number
  maxLength?: number
  // 是否渲染图片
  image?: boolean
  // 出现「变形词（inflected form）」作为答案的概率
  inflectedChance?: number
  // 最长允许的首字母前缀（wdl 手动模式）
  maxPrefixLen?: number
  // random 模式下选中「简单词」的概率（默认 45%，即 40%~50%）
  easyChance?: number
  // 自定义提示语
  textAlready?: string
  textStart?: string
  textNoGame?: string
  textStop?: string
  textLength?: string
  textInvalid?: string
  textPrefix?: string    // 必须以给定开头
  textLose?: string
  textWin?: string
  textReplay?: string    // 询问是否同一首字母再来一局
}

export const Config: Schema<Config> = Schema.object({
  answerDict: Schema.string().description('猜词库路径（每行「单词 含义」）'),
  guessDict: Schema.string().description('合法词库路径（每行一个单词）'),
  easyDict: Schema.string().description('简单词库路径（每行一个单词）'),
  maxGuesses: Schema.number().description('最大猜测次数').default(4).min(2).max(15),
  minLength: Schema.number().description('允许的最小字母数').default(2).min(2).max(20),
  maxLength: Schema.number().description('允许的最大字母数').default(14).min(2).max(30),
  image: Schema.boolean().description('是否渲染图片棋盘（需 puppeteer）').default(true),
  inflectedChance: Schema.number().description('答案选用「变形词」的概率（0~1，建议 >0.5）').default(0.6).min(0).max(1),
  maxPrefixLen: Schema.number().description('首字母前缀最大长度').default(3).min(1).max(5),
  easyChance: Schema.number().description('random 模式选中简单词的概率').default(0.45).min(0).max(1),
  textAlready: Schema.string().description('已有游戏进行中的提示'),
  textStart: Schema.string().description('开局提示'),
  textNoGame: Schema.string().description('未开局就猜的提示'),
  textStop: Schema.string().description('结束游戏的提示'),
  textLength: Schema.string().description('长度不符的提示'),
  textInvalid: Schema.string().description('不是合法单词的提示'),
  textPrefix: Schema.string().description('必须以给定开头开头的提示'),
  textLose: Schema.string().description('猜完失败的提示'),
  textWin: Schema.string().description('猜对的提示'),
  textReplay: Schema.string().description('同一前缀再来一局?的提示'),
})

// ── 词库解析（沿用 wordle 插件风格）──
function defaultDict(filename: string): string {
  const libPath = join(__dirname, filename)
  if (fs.existsSync(libPath)) return libPath
  const srcPath = join(resolve(__dirname, '..'), 'src', filename)
  if (fs.existsSync(srcPath)) return srcPath
  return libPath
}

interface Entry { word: string, meaning: string }

const dictCache: { [filename: string]: { words: Set<string>, entries: Entry[] } } = {}
const easyCache: { [filename: string]: Set<string> } = {}

function loadDict(filename: string) {
  if (dictCache[filename]) return dictCache[filename]
  const words = new Set<string>()
  const entries: Entry[] = []
  try {
    const content = fs.readFileSync(filename, 'utf8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [word, ...rest] = trimmed.split(' ')
      const w = word.toLowerCase()
      words.add(w)
      entries.push({ word: w, meaning: rest.join(' ').trim() })
    }
  } catch (e) {
    console.error('无法打开文件：', e)
  }
  dictCache[filename] = { words, entries }
  return dictCache[filename]
}

function loadEasy(filename: string): Set<string> {
  if (easyCache[filename]) return easyCache[filename]
  const s = new Set<string>()
  try {
    for (const line of fs.readFileSync(filename, 'utf8').split('\n')) {
      const w = line.trim().toLowerCase()
      if (w) s.add(w)
    }
  } catch (e) {
    console.error('无法打开 easywords：', e)
  }
  easyCache[filename] = s
  return s
}

// ── 变形词（inflected form）生成 ──
// 输入一个原形单词，返回常见、拼写正确的变形（复数、三单、过去式、进行时、比较级等）。
function inflect(word: string): string[] {
  const w = word.toLowerCase()
  const out = new Set<string>()
  const add = (x: string) => { if (x.length >= 2) out.add(x) }

  const VOWEL = /[aeiou]/
  const doubleC = (base: string) => {
    const last = base.slice(-1)
    if (base.length < 3) return false
    if (!/[bcdfgjklmnpqrstvwxyz]/.test(last)) return false
    return VOWEL.test(base.slice(-2, -1))
  }

  // 复数 / 三单
  if (/[^aeiou]y$/.test(w)) add(w.slice(0, -1) + 'ies')
  else if (/s$|x$|z$|ch$|sh$/.test(w)) add(w + 'es')
  else add(w + 's')

  // 过去式 / 过去分词
  if (/e$/.test(w)) add(w + 'd')
  else if (doubleC(w)) add(w + w.slice(-1) + 'ed')
  else add(w + 'ed')

  // 进行时
  if (/e$/.test(w)) {
    if (/ee$/.test(w)) add(w + 'ing')
    else add(w.slice(0, -1) + 'ing')
  } else if (doubleC(w)) {
    add(w + w.slice(-1) + 'ing')
  } else {
    add(w + 'ing')
  }

  // 比较级 / 最高级
  if (/e$/.test(w)) { add(w + 'r'); add(w + 'st') }
  else if (doubleC(w)) { add(w + w.slice(-1) + 'er'); add(w + w.slice(-1) + 'est') }
  else {
    if (/[^aeiou]y$/.test(w)) { add(w.slice(0, -1) + 'ier'); add(w.slice(0, -1) + 'iest') }
    else { add(w + 'er'); add(w + 'est') }
  }

  return [...out]
}

// ── 词元还原（宽松判定屈折/变形词）──
function lemmaCandidates(word: string): string[] {
  const w = word.toLowerCase()
  const out = new Set<string>()
  const add = (x: string) => { if (x.length >= 2) out.add(x) }

  if (/ies$/.test(w)) add(w.slice(0, -3) + 'y')
  if (/(ses|xes|zes|ches|shes|oes)$/.test(w)) add(w.slice(0, -2))
  if (/sses$/.test(w)) add(w.slice(0, -2))
  if (/s$/.test(w) && !/ss$/.test(w)) add(w.slice(0, -1))
  if (/ves$/.test(w)) { add(w.slice(0, -3) + 'f'); add(w.slice(0, -3) + 'fe') }

  if (/ied$/.test(w)) add(w.slice(0, -3) + 'y')
  if (/ed$/.test(w)) { add(w.slice(0, -2)); add(w.slice(0, -1)); if (/([^aeiou])\1ed$/.test(w)) add(w.slice(0, -3)) }

  if (/ing$/.test(w)) { add(w.slice(0, -3)); add(w.slice(0, -3) + 'e'); if (/([^aeiou])\1ing$/.test(w)) add(w.slice(0, -4)) }

  if (/iest$/.test(w)) add(w.slice(0, -4) + 'y')
  if (/ier$/.test(w)) add(w.slice(0, -3) + 'y')
  if (/est$/.test(w)) add(w.slice(0, -3))
  if (/er$/.test(w)) add(w.slice(0, -2))
  if (/ily$/.test(w)) add(w.slice(0, -3) + 'y')
  if (/ly$/.test(w)) add(w.slice(0, -2))

  return [...out]
}

// ── 合并词库：主词库 ∪ 简单词 ∪ 简单词的变形 ──
const combinedCache: { [key: string]: { entries: Entry[], words: Set<string> } } = {}

function loadCombined(answerDictPath: string, guessDictPath: string, easyDictPath: string) {
  const key = answerDictPath + '|' + guessDictPath + '|' + easyDictPath
  if (combinedCache[key]) return combinedCache[key]
  const ans = loadDict(answerDictPath)
  const guess = loadDict(guessDictPath)
  const easy = loadEasy(easyDictPath)

  // 合法判定词表：主词库 + 简单词 + 简单词的变形（确保 easy 词及其屈折都可猜）
  const words = new Set<string>(guess.words)
  for (const w of easy) {
    words.add(w)
    for (const i of inflect(w)) if (i.length >= 2) words.add(i)
  }

  // 答案词表：主词库 + 简单词（无释义则填空）
  const entries: Entry[] = [...ans.entries]
  const seen = new Set(entries.map((e) => e.word))
  for (const w of easy) {
    if (seen.has(w)) continue
    seen.add(w)
    entries.push({ word: w, meaning: '' })
  }

  const res = { entries, words }
  combinedCache[key] = res
  return res
}

// ── 合法判定 ──
function WordJud(guessSet: Set<string>, word: string): 0 | 1 {
  const w = (word || '').trim().toLowerCase()
  if (!w) return 0
  if (guessSet.has(w)) return 1
  for (const c of lemmaCandidates(w)) if (guessSet.has(c)) return 1
  return 0
}

// 从合并词表中收集「以 prefix 开头的所有候选」，含原形 + 真实存在的变形
function collectPrefixCandidates(combined: { entries: Entry[], words: Set<string> }, prefix: string): { word: string, inflected: boolean }[] {
  const p = prefix.toLowerCase()
  const out: { word: string, inflected: boolean }[] = []
  const seen = new Set<string>()

  for (const e of combined.entries) {
    if (!e.word.startsWith(p)) continue
    if (!seen.has(e.word)) { seen.add(e.word); out.push({ word: e.word, inflected: false }) }
    for (const inf of inflect(e.word)) {
      if (!inf.startsWith(p)) continue
      if (!combined.words.has(inf)) continue
      if (seen.has(inf)) continue
      seen.add(inf); out.push({ word: inf, inflected: true })
    }
  }
  return out
}

// 按「长度区间 + 是否变形」加权抽取答案
function pickPrefixAnswer(candidates: { word: string, inflected: boolean }[], minLen: number, maxLen: number, inflectedChance: number): { word: string, inflected: boolean } | null {
  const base = candidates.filter((c) => !c.inflected && c.word.length >= minLen && c.word.length <= maxLen)
  const infl = candidates.filter((c) => c.inflected && c.word.length >= minLen && c.word.length <= maxLen)

  if (!infl.length) {
    if (!base.length) return null
    return base[Math.floor(Math.random() * base.length)]
  }
  if (!base.length) {
    return infl[Math.floor(Math.random() * infl.length)]
  }

  if (Math.random() < inflectedChance) {
    return infl[Math.floor(Math.random() * infl.length)]
  }
  return base[Math.floor(Math.random() * base.length)]
}

// 随机模式：根据单词长度决定给出几位首字母（短词→1 位，长词→3 位）
function prefixLenForWord(wordLen: number): number {
  if (wordLen <= 4) return 1
  if (wordLen <= 7) return 2
  return 3
}

const gameData: Record<string, any> = {}

// 记录每个会话最后用过的前缀，供「继续」在同一前缀再来一局（游戏结束后不清除）
const lastPrefix: Record<string, string> = {}

// 调色板
const COLOR = {
  correct: '#6aaa64',
  present: '#c9b458',
  absent: '#787c7e',
  empty: '#d3d6da',
  emptyFill: '#ffffff',
  text: '#ffffff',
  textDark: '#1a1a1b',
  bg: '#ffffff',
  keyText: '#ffffff',
  locked: '#d0342c',       // 红色：锁死的给定开头
  lockedText: '#ffffff',
}

const KEYBOARD_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM']

// 键盘着色只统计「给定开头之后的字母」，与锁死开头完全独立
function letterStates(guesses: { letters: string; marks: string }[], prefixLen: number) {
  const state: Record<string, number> = {}
  for (const guess of guesses) {
    for (let i = prefixLen; i < guess.letters.length; i++) {
      const ch = (guess.letters[i] || '').toUpperCase()
      if (!ch || ch < 'A' || ch > 'Z') continue
      const mark = guess.marks[i]
      const rank = mark === '1' ? 2 : mark === '0' ? 1 : 0
      state[ch] = Math.max(state[ch] ?? -1, rank)
    }
  }
  return state
}

async function renderBoard(
  ctx: Context,
  opts: {
    guesses: { letters: string; marks: string }[]
    length: number
    rows: number
    status?: string
    answer?: string
    remaining?: number
    prefix?: string
    prefixLen?: number
  },
): Promise<any> {
  const { SVG } = require('koishi-plugin-puppeteer')
  const { guesses, length: W, rows: ROWS, status, answer, remaining, prefix, prefixLen: PL = 0 } = opts

  const cell = 1
  const gap = 0.16
  const padTop = status ? 1.5 : 0.5
  const padX = 0.6

  const boardW = W * cell + (W - 1) * gap
  const boardH = ROWS * cell + (ROWS - 1) * gap

  const keyGap = 0.14
  const keyH = 0.82
  const kbRows = KEYBOARD_ROWS.map((r) => r.split(''))
  const maxKeys = Math.max(...kbRows.map((r) => r.length))
  const kbW = Math.max(boardW, maxKeys * 0.78 + (maxKeys - 1) * keyGap)
  const keyW = (kbW - (maxKeys - 1) * keyGap) / maxKeys
  const kbH = kbRows.length * keyH + (kbRows.length - 1) * keyGap
  const kbTop = padTop + boardH + 0.8

  const footH = 0.9
  const viewW = Math.max(boardW, kbW) + padX * 2
  const viewH = kbTop + kbH + footH

  const svg = new SVG({
    viewSize: Math.max(viewW, viewH),
    size: Math.max(520, Math.round(Math.max(viewW, viewH) * 54)),
    viewBox: { top: 0, bottom: viewH, left: 0, right: viewW },
  })
  svg.fill(COLOR.bg)

  if (status) {
    svg.g({
      fill: COLOR.textDark,
      style: 'font-family: system-ui, "PingFang SC", "Microsoft YaHei", Sans; font-weight: 600',
      textAnchor: 'middle',
    } as any).text(status, viewW / 2, 1.0, { fontSize: '0.68' } as any)
  }

  const offsetY = padTop
  const offsetX = (viewW - boardW) / 2

  for (let r = 0; r < ROWS; r++) {
    const guess = guesses[r]
    for (let c = 0; c < W; c++) {
      const x = offsetX + c * (cell + gap)
      const y = offsetY + r * (cell + gap)

      let fillColor = COLOR.emptyFill
      let strokeColor = COLOR.empty
      let letter = ''
      let textColor = COLOR.textDark

      // 锁死的给定开头：每一行都以红色显示
      if (c < PL && prefix) {
        fillColor = COLOR.locked
        strokeColor = COLOR.locked
        letter = prefix[c].toUpperCase()
        textColor = COLOR.lockedText
      } else if (guess) {
        letter = (guess.letters[c] || '').toUpperCase()
        const mark = guess.marks[c]
        if (mark === '1') { fillColor = COLOR.correct; strokeColor = COLOR.correct; textColor = COLOR.text }
        else if (mark === '0') { fillColor = COLOR.present; strokeColor = COLOR.present; textColor = COLOR.text }
        else { fillColor = COLOR.absent; strokeColor = COLOR.absent; textColor = COLOR.text }
      }

      const tile = svg.g({ fill: fillColor, stroke: strokeColor, strokeWidth: 0.05 } as any)
      tile.rect(x, y, x + cell, y + cell, { rx: 0.08, ry: 0.08 } as any)
      if (letter) {
        tile.text(letter, x + cell / 2, y + cell / 2 + 0.22, {
          fill: textColor, fontSize: '0.58', textAnchor: 'middle',
          style: 'font-family: "Helvetica Neue", Arial, Sans; font-weight: 700',
        } as any)
      }
    }
  }

  const states = letterStates(guesses, PL)

  kbRows.forEach((keys, rowIdx) => {
    const rowW = keys.length * keyW + (keys.length - 1) * keyGap
    const rowX = (viewW - rowW) / 2
    const y = kbTop + rowIdx * (keyH + keyGap)

    keys.forEach((ch, i) => {
      const x = rowX + i * (keyW + keyGap)
      const st = states[ch] ?? -1
      let fill: string
      if (st === 2) fill = COLOR.correct
      else if (st === 1) fill = COLOR.present
      else if (st === 0) fill = COLOR.absent
      else fill = COLOR.empty

      const textColor = st === -1 ? COLOR.textDark : COLOR.keyText
      const key = svg.g({ fill } as any)
      key.rect(x, y, x + keyH, y + keyW, { rx: 0.1, ry: 0.1 } as any)
      key.text(ch, x + keyW / 2, y + keyH / 2 + 0.19, {
        fill: textColor, fontSize: '0.44', textAnchor: 'middle',
        style: 'font-family: "Helvetica Neue", Arial, Sans; font-weight: 700',
      } as any)
    })
  })

  const footY = kbTop + kbH + 0.62
  const footG = svg.g({
    fill: COLOR.textDark,
    style: 'font-family: system-ui, "PingFang SC", "Microsoft YaHei", Sans',
    textAnchor: 'middle',
  } as any)
  if (answer) {
    footG.text(`答案：${answer.toUpperCase()}`, viewW / 2, footY, { fontSize: '0.52', fontWeight: 600 } as any)
  } else if (remaining !== undefined) {
    footG.text(`剩余 ${remaining} 次`, viewW / 2, footY, { fontSize: '0.46', fill: '#787c7e' } as any)
  }

  return svg.render(ctx)
}

// 判定：锁死开头之后的部分做标准 Wordle 着色（前缀位标 L）
function testword(word: string, input: string, prefixLen: number) {
  const len = word.length
  const test = new Array(len).fill('*')
  for (let i = 0; i < prefixLen; i++) test[i] = 'L'

  let ct = 0
  for (let i = prefixLen; i < len; i++) {
    const a = word[i].toLowerCase()
    const b = input[i].toLowerCase()
    if (a === b) { test[i] = '1'; ct++; continue }
    for (let j = prefixLen; j < len; j++) {
      const c = input[j].toLowerCase()
      if (a === c && test[j] === '*') { test[j] = '0'; break }
    }
  }
  const suffixOk = ct === (len - prefixLen)
  return { iftest: suffixOk ? 1 : 0, test: test.join('') }
}

export function apply(ctx: Context, config: Config) {
  ctx = ctx.guild()

  const maxGuesses = config.maxGuesses ?? 4
  const answerDict = config.answerDict || defaultDict('tiku.txt')
  const guessDict = config.guessDict || defaultDict('djciku.txt')
  const easyDict = config.easyDict || defaultDict('easywords.txt')
  const minLen = config.minLength ?? 2
  const maxLen = config.maxLength ?? 14
  const maxPrefixLen = config.maxPrefixLen ?? 3
  const inflectedChance = config.inflectedChance ?? 0.6
  const easyChance = config.easyChance ?? 0.45

  const t = {
    already: config.textAlready ?? '本群已有一局进行中，先猜完或 wdlq 结束它吧',
    start: config.textStart ?? '开始猜词！',
    noGame: config.textNoGame ?? '还没有进行中的游戏，先输入 wdl <前缀> 或 wdl random 开始一局吧',
    stop: config.textStop ?? '游戏已结束，下次再来玩～',
    length: config.textLength ?? '长度不对哦，再数一下？',
    invalid: config.textInvalid ?? '这不是一个有效单词，换个词试试？',
    prefix: config.textPrefix ?? '单词必须以给定的开头哦',
    lose: config.textLose ?? '没猜出来，再接再厉',
    win: config.textWin ?? '猜对了！',
    replay: config.textReplay ?? 'Same prefix again? Type continue or wdlct to play another round.',
  }

  ctx.command('wordle-letters [prefix] [length]', '首字母猜词游戏')
    // wdlct / continue 用「精确快捷 + gcontinue 选项」：
    // 精确快捷会消费整条消息（input 为空），所以必须靠选项标记，
    // 不能用 input 判断。且必须放在 wdl 之前，避免 wdl 的 fuzzy 吃掉 "wdlct"。
    .shortcut('wdlct', { options: { gcontinue: true } })
    .shortcut('continue', { options: { gcontinue: true } })
    .shortcut('wdl', { fuzzy: true })
    .shortcut('首字母猜词', { fuzzy: true })
    .shortcut('停止首字母猜词', { options: { gstop: true } })
    .shortcut('wdlq', { options: { gstop: true } })
    .shortcut('wdlquit', { options: { gstop: true } })
    .shortcut('wdlr', { options: { gnew: true }, fuzzy: true })
    .option('gstart', '开始游戏')
    .option('gnew', '开一局并把参数作为第一次猜测')
    .option('gstop', '停止游戏')
    .option('gcontinue', '同一前缀再来一局')
    .action(async ({ session, options }, input, lengthArg) => {
      const { cid } = session
      const rawInput = (input || '').trim()
      const rawLength = (lengthArg || '').trim()

      const combined = loadCombined(answerDict, guessDict, easyDict)

      // 继续上一局同一前缀（前缀记录独立于游戏，游戏结束后仍可用）
      // 通过 wdlct / continue 精确快捷触发（options.gcontinue），
      // 也兼容直接在命令行输入 continue/继续/再来。
      if (options.gcontinue || rawInput === 'continue' || rawInput === '继续' || rawInput === '再来') {
        const prev = lastPrefix[cid]
        if (!prev) return t.noGame
        return await startGame(prev)
      }

      async function startGame(prefix: string, len?: number) {
        if (gameData[cid]) {
          await session.send(t.already)
          await sendBoard()
          return
        }
        prefix = prefix.toLowerCase()
        if (!/^[a-z]+$/.test(prefix)) return '首字母前缀只能由英文字母组成'
        if (prefix.length > maxPrefixLen) return `前缀最长 ${maxPrefixLen} 个字母`

        const cands = collectPrefixCandidates(combined, prefix)
        if (!cands.length) return `没有找到以 "${prefix}" 开头的单词`

        let answer: { word: string, inflected: boolean } | null
        if (len) {
          const scoped = cands.filter((c) => c.word.length === len)
          if (!scoped.length) return `没有找到以 "${prefix}" 开头、${len} 个字母的单词`
          answer = pickPrefixAnswer(scoped, len, len, inflectedChance)
        } else {
          answer = pickPrefixAnswer(cands, minLen, maxLen, inflectedChance)
        }
        if (!answer) return `没有找到以 "${prefix}" 开头的 ${minLen}~${maxLen} 字母单词`

        const ansWord = answer.word
        lastPrefix[cid] = prefix
        gameData[cid] = {
          guesses: [],
          word: ansWord,
          lenth: ansWord.length,
          test: { value: '*'.repeat(ansWord.length) },
          ct: 0,
          prefix,
          prefixLen: prefix.length,
          usedPrefix: prefix,
          inflected: answer.inflected,
        }
        const inflNote = answer.inflected ? '（这个答案是某个单词的变形）' : ''
        await session.send(`请猜一个以 "${prefix}" 开头、${ansWord.length} 个字母的单词${inflNote}：`)
        await sendBoard(t.start)
      }

      // 随机模式：先选单词，再按长度给出 1~3 位首字母
      async function startRandom() {
        if (gameData[cid]) {
          await session.send(t.already)
          await sendBoard()
          return
        }
        // 40%~50% 概率抽简单词
        let pool: Entry[]
        if (Math.random() < easyChance) {
          pool = loadDict(easyDict).entries.length ? combined.entries.filter((e) => loadEasy(easyDict).has(e.word)) : combined.entries
          if (!pool.length) pool = combined.entries
        } else {
          pool = combined.entries
        }
        const scoped = pool.filter((e) => e.word.length >= minLen && e.word.length <= maxLen)
        if (!scoped.length) return `没有可用单词，请调整长度范围`

        const word = scoped[Math.floor(Math.random() * scoped.length)].word
        const pl = prefixLenForWord(word.length)
        const prefix = word.slice(0, pl)

        lastPrefix[cid] = prefix
        gameData[cid] = {
          guesses: [],
          word,
          lenth: word.length,
          test: { value: '*'.repeat(word.length) },
          ct: 0,
          prefix,
          prefixLen: pl,
          usedPrefix: prefix,
          inflected: false,
        }
        await session.send(`随机模式：请猜一个以 "${prefix}" 开头、${word.length} 个字母的单词：`)
        await sendBoard(t.start)
      }

      async function sendBoard(status?: string, answer?: string) {
        const g = gameData[cid]
        if (!g) return
        const remaining = maxGuesses - g.ct
        if (config.image && session.app.puppeteer) {
          try {
            const img = await renderBoard(ctx, {
              guesses: g.guesses, length: g.lenth, rows: maxGuesses,
              status, answer, remaining, prefix: g.prefix, prefixLen: g.prefixLen,
            })
            await session.send(img)
            return
          } catch (e) {
            console.error('wordle-letters 图片渲染失败，回退文本：', e)
          }
        }
        let text = g.guesses.map((x) => `${x.letters}\n${x.marks}`).join('\n')
        if (status) text = status + '\n' + text
        if (answer) text += `\n答案：${answer}`
        await session.send(text)
      }

      // ── 停止 ──
      if (options.gstop) {
        if (!gameData[cid]) return t.noGame
        delete gameData[cid]
        delete lastPrefix[cid]
        return t.stop
      }

      // ── 开始：wdl random / wdl <prefix> [length] ──
      if (options.gstart || (!options.gstop && !gameData[cid])) {
        if (!rawInput) return '用法：wdl random 或 wdl <前缀> [字母数]，如 wdl ex 或 wdl a 4'
        if (rawInput.toLowerCase() === 'random' || rawInput.toLowerCase() === '随') {
          await startRandom()
          return
        }
        let len: number | undefined
        if (rawLength && /^\d+$/.test(rawLength)) len = parseInt(rawLength, 10)
        if (!len && rawInput && /^\d+$/.test(rawInput)) len = parseInt(rawInput, 10)
        await startGame(rawInput, len)
        return
      }

      // ── 进行中：猜词 ──
      if (!gameData[cid]) return t.noGame

      const g = gameData[cid]
      // 必须长度匹配
      if (rawInput.length !== g.lenth) return t.length
      // 必须是合法单词
      if (WordJud(combined.words, rawInput) === 0) return t.invalid
      // 必须以给定开头开头（严格限制，不允许其他开头）
      if (!rawInput.toLowerCase().startsWith(g.prefix)) return t.prefix

      const aa = testword(g.word, rawInput, g.prefixLen)
      g.test.value = aa.test
      g.guesses.push({ letters: rawInput, marks: aa.test })
      if (aa.iftest === 0) {
        g.ct += 1
        if (g.ct >= maxGuesses) {
          await sendBoard(t.lose, g.word)
          delete gameData[cid]
          await session.send(t.replay)
          return
        }
        await sendBoard()
      } else {
        await sendBoard(t.win, g.word)
        const prevPrefix = g.prefix
        delete gameData[cid]
        await session.send(t.replay)
        return
      }
    })
}
