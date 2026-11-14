// runner-so/setup-docker-builder's post step: reports the job's builds for
// Docker Analytics and stops buildkitd, so the disk the control plane
// commits at the job's end holds a clean BuildKit state. It never fails
// the job; whether the cache commits is the control plane's call (trusted
// run, job succeeded), from webhook data.
const { execFileSync } = require("node:child_process")
const { BUILDER, DOCKER_BUILDS_MAX, parseHistory, guestd } = require("./lib.js")

const run = (cmd, ...args) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString()

async function post() {
  const since = Number(process.env.STATE_started)
  const cacheKey = process.env.STATE_cacheKey
  if (!since || !cacheKey) return // the main step never got as far
  try {
    const text = run("docker", "buildx", "history", "ls", "--builder", BUILDER, "--format", "json", "--no-trunc")
    const builds = parseHistory(text, since, Date.now()).slice(-DOCKER_BUILDS_MAX)
    if (builds.length) {
      const r = await guestd(`/docker-builds?${new URLSearchParams({ key: cacheKey })}`, JSON.stringify(builds), 60_000)
      if (r.code !== 200) console.log(`Docker builds not reported: ${r.text || r.code}`)
      else console.log(`${builds.length} Docker builds reported`)
    }
  } catch (e) {
    console.log(`Docker builds not reported: ${e.message}`)
  }
  try {
    run("sudo", "-n", "pkill", "-TERM", "-x", "buildkitd")
    for (let i = 0; i < 60; i++) {
      try {
        run("pgrep", "-x", "buildkitd")
      } catch {
        break // gone
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    run("sync")
  } catch (e) {
    console.log(`buildkitd not stopped: ${e.message}`)
  }
}

post()
