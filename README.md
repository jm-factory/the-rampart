# The Rampart

A public news site. Claude writes 2–3 new articles three times a day from current reporting, and every article links its sources.

- `index.html` is the whole site. It loads `articles.json`.
- `articles.json` holds all the articles, newest first.
- `scripts/write-articles.mjs` researches the news with Claude's web search, writes the articles, and adds them to `articles.json`.
- `.github/workflows/news.yml` runs the writer at 7am, noon and 5pm Central, saves the new articles, and redeploys the site.

## Setup (about 15 minutes, one time)

### 1. Get an Anthropic API key
1. Go to **console.anthropic.com** and sign in or create an account.
2. Add a payment method under **Billing**. Set a **monthly spend limit** there too, so costs can't surprise you.
3. Go to **API Keys** → **Create Key**. Copy the key; you only see it once.

### 2. Put the code on GitHub
1. Sign in at **github.com** and click **New repository**.
2. Name it `the-rampart` and set it to **Public**. GitHub Pages is free for public repos.
3. On the new repo page, click **uploading an existing file**. Drag in everything from this folder, including the hidden `.github` folder. On a Mac, press **Cmd + Shift + .** in Finder to show hidden folders.
4. Click **Commit changes**.

### 3. Add your API key as a secret
Go to **Settings → Secrets and variables → Actions → New repository secret**.
- Name: `ANTHROPIC_API_KEY`
- Secret: paste your key

### 4. Turn on GitHub Pages
Go to **Settings → Pages**. Under **Build and deployment → Source**, choose **GitHub Actions**.

### 5. Run it once
Go to the **Actions** tab → **News wire** → **Run workflow**.
After about 2–4 minutes the run finishes, and your site is live at
`https://<your-username>.github.io/the-rampart/`

From then on it updates itself on schedule. Each run shows up in the Actions tab with a log of what was published or skipped.

## Adding a domain later
1. Buy a domain from any registrar (Cloudflare, Namecheap, Porkbun, …).
2. In **Settings → Pages → Custom domain**, enter it and save.
3. At your registrar, add the DNS records GitHub shows you. For a `www.` address that's a CNAME pointing to `<your-username>.github.io`. For a bare domain it's the four A records GitHub lists.
4. After DNS takes effect, check **Enforce HTTPS**.

## Changing things
- **Schedule:** edit the `cron` line in `.github/workflows/news.yml`. Times are in UTC. Central daylight time is UTC−5; standard time is UTC−6.
- **Voice, rules and sections:** edit `SYSTEM`, `USER` and `SECTIONS` in `scripts/write-articles.mjs`. If you change sections, update `SECTIONS` in `index.html` too.
- **Model:** set a repository variable `RAMPART_MODEL` (Settings → Secrets and variables → Actions → Variables), for example `claude-opus-5-5` for stronger writing at a higher cost. The default is `claude-sonnet-5`.
- **Remove an article:** delete its entry from `articles.json` on GitHub and commit. The site redeploys automatically.

## Built-in safeguards
- An article is published only if at least one of its source links is a page Claude actually retrieved during that run. Stories with only unverifiable links are dropped.
- Only the five known sections are accepted, and only one story can be marked Breaking at a time.
- Every page says the article is AI-written and lists its sources.

## Cost
Each run makes up to 12 web searches (web search costs $10 per 1,000) plus model tokens. A rough estimate is $5–15 a week on the default model, depending on how much each run searches. Check the Usage page in the Anthropic console after the first few days, and keep a spend limit set.
