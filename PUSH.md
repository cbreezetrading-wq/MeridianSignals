# Push preparation

This repository is fully prepared and committed locally. It has **not** been pushed —
GitHub access was not configured for this team at the time of export.

Target remote: `https://github.com/cbreezetrading-wq/MeridianSignals.git`

No credential appears in this file. Authentication is yours to supply — use a GitHub
personal access token, or `gh auth login`, or an SSH remote instead of HTTPS. Nothing in
this repo depends on which you pick.

---

## 1. Confirm the export is clean before you push

Run these from the repository root. Each should print nothing, or a single commit.

```bash
# one commit, clean tree
git log --oneline
git status --short

# the ignored files really are ignored — none of these should be tracked
git ls-files | grep -E 'node_modules|/dist/|\.run/|\.env|data/|signals\.jsonl|orders\.jsonl|executionStatus\.json|^verify/'

# nothing over 5 MB, and no credential-shaped strings
find . -path ./.git -prune -o -type f -size +5M -print
grep -rn -E 'Bearer [A-Za-z0-9]|OANDA_TOKEN|API_KEY|SECRET|PASSWORD' --exclude-dir=.git .
```

## 2. Set the remote and push

```bash
git remote add origin https://github.com/cbreezetrading-wq/MeridianSignals.git
# if 'origin' already exists:  git remote set-url origin https://github.com/cbreezetrading-wq/MeridianSignals.git

git branch -M main
git push -u origin main
```

If the remote repository already contains a commit (for example a README created when the
repo was made on GitHub), the push will be rejected as non-fast-forward. Do **not** force
over it blindly. Either merge it:

```bash
git pull --rebase origin main
git push -u origin main
```

or, if the remote commit is a throwaway placeholder you are happy to discard:

```bash
git push --force-with-lease -u origin main
```

## 3. Confirm the push landed

```bash
# the remote's refs, read fresh from GitHub — no local state involved
git ls-remote origin

# and a real fetch into a scratch clone, which is the only proof the objects are there
git clone https://github.com/cbreezetrading-wq/MeridianSignals.git /tmp/meridian-verify
cd /tmp/meridian-verify && git log --oneline && ls -la
```

`git ls-remote origin` should print one line for `refs/heads/main` whose SHA matches your
local `git rev-parse HEAD`. The scratch clone should contain `README.md`, `site/`,
`execution/`, `backtest/`, `daily/` and `skills/`, and should **not** contain
`node_modules/`, any `data/` directory, `verify/`, or
`site/src/lib/executionStatus.json`.

## 4. After the push

Nothing in this repo is live until you publish the site from the working environment.
The pushed repository is source only: the signal log and execution record are runtime
state that lives with the running system, not in git.
