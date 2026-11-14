// The pure parts of runner-so/setup-docker-builder (RUN-513), tested by
// lib.test.js: node built-ins only, so the action needs no install step.

const http = require("node:http")

const SOCKET = "/run/buildkit/buildkitd.sock"
const ROOT = "/var/lib/buildkit"
const BUILDER = "runner-builder"
// DOCKER_BUILDS_MAX is runtime.DockerBuildsMax: the most builds one report,
// and one job, may record.
const DOCKER_BUILDS_MAX = 100

// diskKey is the sticky disk holding cache key's Docker layer cache: the
// control plane commits a disk under this prefix only when its job succeeded.
function diskKey(cacheKey) {
  const k = String(cacheKey ?? "").trim()
  if (!k) throw new Error("cache-key: give the Docker layer cache a name")
  return "docker-layer-cache/" + k
}

// buildkitdConfig keeps BuildKit's state under root (the sticky disk) and
// garbage-collects records unused for 8 days, and anything past 80% of the
// disk, oldest first.
function buildkitdConfig(root) {
  return `root = ${JSON.stringify(root)}

[grpc]
  address = ["unix://${SOCKET}"]

[history]
  maxAge = 691200
  maxEntries = 200

[worker.oci]
  enabled = true
  gc = true
  [[worker.oci.gcpolicy]]
    all = true
    keepDuration = "192h"
  [[worker.oci.gcpolicy]]
    all = true
    maxUsedSpace = "80%"

[worker.containerd]
  enabled = false
`
}

// jobEnv is what the job's later steps get in GITHUB_ENV. Docker 29's plain
// `docker build` ignores the current builder that `buildx create --use`
// sets, but every buildx front end (docker build, docker buildx build and
// bake, docker/build-push-action) honours BUILDX_BUILDER (RUN-530). Not
// ACTIONS_CACHE_SERVICE_V2: runner-cache speaks the cache protocol v1, which
// buildx's type=gha uses unless that is set (ADR 0046 §5).
function jobEnv() {
  return [`BUILDX_BUILDER=${BUILDER}`]
}

const STATUS = { Completed: "completed", Error: "error", Running: "canceled" }

// parseHistory reads `docker buildx history ls --format json` (one record
// a line) into the builds this job ran: those created at or after since.
// A build still running when the job ends was cancelled; now ends it.
function parseHistory(text, since, now) {
  const out = []
  for (const line of text.split("\n")) {
    let r
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const start = Date.parse(r?.created_at)
    const status = STATUS[r?.status]
    if (!status || !(start >= since)) continue
    const end = r.completed_at ? Date.parse(r.completed_at) : now
    out.push({
      ref: String(r.ref).split("/").pop(),
      name: String(r.name ?? ""),
      status,
      startedAt: new Date(start).toISOString(),
      durationMs: Math.max(0, Math.round(end - start)),
      totalSteps: r.total_steps | 0,
      cachedSteps: r.cached_steps | 0,
    })
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}

// guestd asks runner-guestd over its step socket, as runner-so/stickydisk
// does: no credential enters the job. It answers the status and body.
function guestd(path, body, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { socketPath: "/run/runner/stickydisk.sock", path, method: "POST", timeout: timeoutMs,
        headers: body ? { "Content-Type": "application/json" } : {} },
      (res) => {
        let text = ""
        res.on("data", (c) => (text += c))
        res.on("end", () => resolve({ code: res.statusCode, text: text.trim() }))
      }
    )
    req.on("timeout", () => req.destroy(new Error("no answer in time")))
    req.on("error", (e) => resolve({ code: 0, text: e.message }))
    req.end(body)
  })
}

module.exports = { SOCKET, ROOT, BUILDER, DOCKER_BUILDS_MAX, diskKey, buildkitdConfig, jobEnv, parseHistory, guestd }
