// Minimal GitHub REST client for the active-conversation dedupe check --
// only reads/comments on open issues, never files new ones.
export function ghTokenForRepo(repo) {
  // A fine-grained PAT is scoped to one org, so pick by the repo's org.
  return repo.startsWith("themegrill/") ? process.env.BOT_TOKEN_THEMEGRILL : process.env.BOT_TOKEN;
}

// Restricted to our own bug-report-triage-labeled issues -- matching every
// open issue once produced a false positive against an unrelated community
// thread. Tradeoff: can't catch a duplicate against a pre-existing,
// never-labeled bug -- accepted as the safer default.
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

export async function listIssueComments(repo, number) {
  const token = ghTokenForRepo(repo);
  const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`GitHub list comments failed on ${repo}#${number}: ${res.status} ${await res.text()}`);
  return res.json();
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
