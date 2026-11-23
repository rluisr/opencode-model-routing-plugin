import assert from "node:assert/strict"
import plugin from "./index.js"

const options = {
  apiKey: "key",
  models: ["litellm/group/general#high", "litellm/claude-opus-5-5#high", "litellm/claude-fable-5-2"],
}

let reply
let requests
globalThis.fetch = async (url, init) => {
  requests.push({ url, init })
  return reply.clone()
}
const scored = (score) => Response.json({ answers: { complexity: { type: "score", score } } })

async function load({ session = {}, messages = [], opts = options } = {}) {
  requests = []
  const switched = []
  let hook
  await plugin.setup({
    options: opts,
    session: {
      hook: async (name, callback) => name === "prompt" && (hook = callback),
      get: async () => session,
      context: async () => messages,
      switchModel: async (input) => switched.push(input),
    },
  })
  return { switched, prompt: (text = "typo を直して") => hook({ sessionID: "ses_a", prompt: { text } }) }
}

async function route({ text, ...state } = {}) {
  const { switched, prompt } = await load(state)
  await prompt(text)
  return switched
}

reply = scored(0.1)
assert.deepEqual(
  await route(),
  [{ sessionID: "ses_a", model: { providerID: "litellm", id: "group/general", variant: "high" } }],
  "a simple first prompt starts the session on the first model",
)
assert.equal(requests[0].url, "https://api.router.hello.ai/v1/systemone")
assert.equal(requests[0].init.headers.authorization, "Bearer key")
const body = JSON.parse(requests[0].init.body)
assert.equal(body.model, "clef-flash")
assert.equal(body.state, "typo を直して", "the prompt is what gets judged")
assert.equal(body.questions.complexity.criteria.length, 3, "one level per model")

reply = scored(1.27)
assert.equal((await route())[0].model.id, "claude-opus-5-5", "a somewhat complex prompt uses the second model")

reply = scored(1.9)
assert.deepEqual(
  (await route())[0].model,
  { providerID: "litellm", id: "claude-fable-5-2" },
  "a complex prompt uses the third model, and a model without a variant has none",
)

reply = scored(0.1)
await route({ text: "鰆".repeat(8000) })
assert.equal(Buffer.byteLength(JSON.parse(requests[0].init.body).state), 15_000, "a long prompt is cut by bytes, which bound the API's token count")
await route({ text: "a" + "😀".repeat(8000) })
assert.ok(JSON.parse(requests[0].init.body).state.isWellFormed(), "a cut through a multi-byte character leaves no lone surrogate")

reply = scored(1.9)
assert.deepEqual(await route({ messages: [{ type: "user" }] }), [], "a later prompt keeps the session's model")
assert.equal(requests.length, 0, "a later prompt is not judged")
assert.deepEqual(await route({ messages: [{ type: "compaction" }] }), [], "a compacted session keeps its model")
assert.equal((await route({ messages: [{ type: "model-switched" }] })).length, 1, "a model picked before the first prompt is replaced")
assert.deepEqual(await route({ session: { parentID: "ses_p" } }), [], "a subagent session keeps its agent's model")

{
  const { switched, prompt } = await load({ opts: { ...options, ignore: ["no-routing"] } })
  await prompt("no-routing のまま回答して")
  assert.deepEqual(switched, [], "a prompt with an ignore keyword keeps the session's model")
  assert.equal(requests.length, 0, "a prompt with an ignore keyword is not judged")
  await prompt("typo を直して")
  assert.equal(requests.length, 1, "other prompts are still judged")
}

reply = Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
assert.deepEqual(await route(), [], "a prompt is still admitted, on the session's model, when the API fails")

reply = scored(1.9)
const both = await load()
let order = []
await Promise.all(["A", "B"].map((text) => both.prompt(text).then(() => order.push(text))))
assert.equal(requests.length, 1, "a prompt that arrives while the first is being judged is not judged")
assert.equal(JSON.parse(requests[0].init.body).state, "A", "the first prompt is the one judged")
assert.equal(both.switched.length, 1, "only the first prompt picks the model")
assert.deepEqual(order, ["A", "B"], "the later prompt is admitted after the one it waited for")
await both.prompt("C")
assert.equal(requests.length, 2, "a finished judgment is not remembered")

reply = Response.json({ error: { message: "Invalid API key" } }, { status: 401 })
const failing = await load()
order = []
await Promise.all(["A", "B"].map((text) => failing.prompt(text).then(() => order.push(text))))
assert.equal(requests.length, 1, "a failed judgment is not retried by the prompt that waited for it")
assert.deepEqual(order, ["A", "B"], "the later prompt is admitted after the one it waited for, when the API fails too")
assert.deepEqual(failing.switched, [], "both prompts are admitted on the session's model")

await assert.rejects(plugin.setup({ options: { apiKey: "key", models: options.models.slice(1) } }), /3 models/)
await assert.rejects(plugin.setup({ options: { models: options.models } }), /apiKey/)
await assert.rejects(plugin.setup({ options: { ...options, models: ["a", "b/c", "d/e"] } }), /"a" is not provider\/model#variant/)

console.log("ok")
