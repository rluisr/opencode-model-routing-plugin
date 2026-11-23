const ENDPOINT = "https://api.router.hello.ai/v1/systemone"
const LEVELS = [
  "シンプル: 単純な質問、1ファイルの小さな修正、定型作業",
  "少し複雑: 複数ファイルにまたがる実装、調査を伴う修正",
  "複雑: 設計判断が必要、大規模な実装やリファクタ、原因不明のバグ調査",
]
const STARTED = ["user", "assistant", "compaction"]

function ref(model) {
  const match = /^([^/]+)\/([^#]+)(?:#(.+))?$/.exec(model)
  if (!match) throw new Error(`model-routing: "${model}" is not provider/model#variant`)
  const [, providerID, id, variant] = match
  return { providerID, id, ...(variant && { variant }) }
}

async function level(apiKey, text) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "clef-flash",
      // ponytail: the API rejects 16,384 tokens or more, so only the head is judged; chunk and take the max if long prompts get misrouted.
      // Not a character count: a rare kanji is 3 tokens, and a cut through a surrogate pair is rejected as invalid.
      state: Buffer.from(text).subarray(0, 15_000).toString(),
      questions: {
        complexity: {
          type: "score",
          instructions: "このコーディングエージェントへの依頼はどれほど複雑なタスクですか？",
          criteria: LEVELS,
        },
      },
    }),
    // Not left to the API: the prompt is not admitted until this hook returns.
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return Math.round((await response.json()).answers.complexity.score)
}

export default {
  id: "model-routing",

  async setup(ctx) {
    const { apiKey, models, ignore = [] } = ctx.options ?? {}
    if (!apiKey || models?.length !== LEVELS.length)
      throw new Error(`model-routing: options need apiKey and ${LEVELS.length} models, simplest first`)
    const refs = models.map(ref)
    const pending = new Map()

    await ctx.session.hook("prompt", async ({ sessionID, prompt }) => {
      // Not thrown: a failed hook drops the prompt, and the session's own model is a usable fallback.
      try {
        const [session, messages] = await Promise.all([
          ctx.session.get({ sessionID }),
          ctx.session.context({ sessionID }),
        ])
        // Not judged at all: the user kept the session's model for prompts like this one.
        if (ignore.some((keyword) => prompt.text.includes(keyword))) return
        // Not subagent sessions: their model is the one configured for the agent.
        if (session.parentID || messages.some((message) => STARTED.includes(message.type))) return
        // Not judged again: the first prompt is not in the context until its hook returns, so a prompt
        // that arrives meanwhile would look like the first one and switch the model last.
        // Not returned at once: that prompt would then be admitted before the first one.
        // ponytail: a prompt arriving between this hook's return and the first prompt's admission is still judged; recheck the context after judging if that shows up.
        if (pending.has(sessionID)) return pending.get(sessionID).catch(() => {})
        // Not cleaned up in a promise only this hook awaits: it settles later than the one the waiting prompt awaits.
        const routing = level(apiKey, prompt.text)
          .then((score) => ctx.session.switchModel({ sessionID, model: refs[score] }))
          .finally(() => pending.delete(sessionID))
        pending.set(sessionID, routing)
        await routing
      } catch (error) {
        console.error("[model-routing]", error)
      }
    })
  },
}
