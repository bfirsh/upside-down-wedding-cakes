# Push this to GitHub

The repo contents are already committed on branch `main`. From this folder:

    git remote add origin https://github.com/bfirsh/upside-down-wedding-cakes.git
    git push -u origin main

If GitHub rejects the push because the repo was created with a README, either
delete and recreate it empty, or:

    git pull --rebase origin main && git push -u origin main

## Then turn on Pages

Settings → Pages → Source: **Deploy from a branch** → `main` / `/ (root)` → Save.
Live a minute later at https://bfirsh.github.io/upside-down-wedding-cakes/

## Then bake the data

Actions → **Refresh airspace data** → Run workflow. It downloads the national
airspace dataset from the FAA, tiles it into `data/`, and commits. Takes a few
minutes. After that the site stops querying the FAA at runtime entirely, and the
weekly cron keeps it current on the 28-day chart cycle.

Until that first run, the page falls back to querying the FAA live — which works,
but is subject to their shared rate limit.
