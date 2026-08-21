// Minimal GitHub REST client for the active-conversation dedupe check.
// No `gh` CLI, no repo checkout, no OpenCode -- this path only ever reads and
// comments on already-open issues, never files new ones or investigates
// code, so it doesn't need any of that machinery.
export function ghTokenForRepo(repo) {
  // Same rule as the workflow's startsWith(...) expression for Stage 2:
  // a fine-grained PAT is scoped to one resource owner, so which token to
  // use depends on which org this repo belongs to.
  return repo.startsWith("themegrill/") ? process.env.BOT_TOKEN_THEMEGRILL : process.env.BOT_TOKEN;
}

// Restricted to our own AI-filed issues (labeled bug-report-triage), not
// every open issue in the repo. Matching against generic pre-existing
// community threads that were never really bugs produced a real false
// positive (a vague "no updates in months?" discussion issue) that posted a
// wrong comment and a wrong note into a real customer's chat. The tradeoff:
// this can't catch a duplicate against a genuine bug that predates this
// system and was never labeled -- accepted as the safer default.
export async function listOpenIssues(repo) {
  const token = ghTokenForRepo(repo);
  const res = await fetch(
    `https://api.github.com/repos/${repo}/issues?state=open&labels=bug-report-triage&per_page=100`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } }
  );
  if (!res.ok) throw new Error(`GitHub list issues failed for ${repo}: ${res.status} ${await res.text()}`);
  const issues = await res.json();
  return issues.filter((i) => !i.pull_request); // /issues also returns PRs
}

export async function commentOnIssue(repo, number, body) {
  const token = ghTokenForRepo(repo);
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitHub comment failed on ${repo}#${number}: ${res.status} ${await res.text()}`);
  return res.json();
}
