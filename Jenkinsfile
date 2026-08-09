// crust-website — build the Astro site and publish it to the static plane.
//
// Caddy already has the vhost (`crust.in.drlario.org` -> /srv/sites/crust-website/current),
// so nothing here touches the Caddyfile — which is fortunate, because that file is a
// single-file bind mount and editing it needs a --force-recreate, not a reload.
//
// `current` is a symlink site-deploy swaps atomically and Caddy resolves per request, so a
// deploy needs no reload at all.
pipeline {
    agent any
    options {
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }
    environment {
        // crust is private and LAN-only, so the canonical host is the internal vhost. This is
        // the ONLY consumer of Astro.site (src/layouts/Layout.astro does
        // `new URL(Astro.url.pathname, Astro.site)`), and an undefined value throws — so the
        // build fails loudly rather than emitting wrong canonical tags.
        SITE_URL = 'https://crust.in.drlario.org'
        SITE     = 'crust-website'
    }
    stages {
        stage('Preflight') {
            steps {
                sh '''
                    set -eu
                    test -w /srv/sites || { echo "/srv/sites not writable"; exit 1; }
                    test -x /opt/publish/bin/site-deploy || { echo "site-deploy not mounted"; exit 1; }
                    test -f bun.lock || { echo "no bun.lock"; exit 1; }
                    # bun.lock is the ONLY lockfile now. package-lock.json used to sit beside it
                    # pinning a different astro (6.4.8 vs 6.3.7) with nothing keeping the two in
                    # step, so it was deleted rather than maintained.
                    test ! -f package-lock.json || {
                        echo "package-lock.json is back — bun.lock is the source of truth here"; exit 1; }
                    echo "astro: $(grep -oE '\"astro@[0-9][^\"]*\"' bun.lock | head -1)"
                '''
            }
        }
        stage('Build') {
            steps {
                sh '''
                    set -eu
                    rm -rf dist

                    # No -v "$PWD:/w". The workspace lives in the jenkins_home NAMED VOLUME, so
                    # that host path does not exist as the daemon resolves it — the classic
                    # docker-outside-of-docker trap. Move the tree in and the artifact out with
                    # docker cp, which goes through the client and therefore sees the volume.
                    # oven/bun:1 — the same image crust's own binary job uses, so the whole
                    # crust family builds on one toolchain rather than this site being the only
                    # thing that needs node.
                    CID=$(docker create -w /w -e SITE_URL="$SITE_URL" oven/bun:1 \
                            sh -c 'set -eu; cd /w; bun install --frozen-lockfile; bun run build')
                    trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

                    docker cp "$PWD/." "$CID:/w" >/dev/null
                    docker start -a "$CID"
                    docker cp "$CID:/w/dist/." "$WORKSPACE/dist/"

                    test -s dist/index.html || { echo "no index.html in dist"; exit 1; }
                    test -s dist/404.html   || { echo "no 404.html — Caddy's handle_errors block would be inert"; exit 1; }
                    echo "built $(find dist -name '*.html' | wc -l) page(s)"
                '''
            }
        }
        stage('Gate') {
            steps {
                sh '''
                    set -eu
                    # crust is not public. A build that leaks the repo URL or the not-yet-real
                    # public domain into the served HTML is a defect, so fail on it here rather
                    # than discovering it in a browser.
                    if grep -rlE 'github\\.com|larioborges-timbuk2|crust\\.sh' dist; then
                        echo "FAIL: public references found in built output (see files above)"
                        exit 1
                    fi
                    grep -q 'rel="canonical" href="https://crust.in.drlario.org/"' dist/index.html \
                        || { echo "FAIL: canonical URL is not the LAN host"; exit 1; }
                    echo "gate passed: no public references, canonical is correct"
                '''
            }
        }
        stage('Deploy') {
            steps {
                sh '''
                    set -eu
                    VERSION="$(node -p "require('./package.json').version")+$(git rev-parse --short HEAD).${BUILD_NUMBER}"
                    /opt/publish/bin/site-deploy "$SITE" "$WORKSPACE/dist" "$VERSION"
                '''
            }
        }
        stage('Verify') {
            steps {
                sh '''
                    set -eu
                    # Assert against the live URL, not against what we just wrote to disk.
                    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "$SITE_URL/")
                    echo "$SITE_URL/ -> $code"
                    [ "$code" = 200 ] || exit 1

                    nf=$(curl -sS -o /dev/null -w '%{http_code}' -m 30 "$SITE_URL/definitely-not-a-page")
                    echo "missing path -> $nf"
                    [ "$nf" = 404 ] || exit 1

                    curl -sS -m 30 "$SITE_URL/" | grep -q 'apps.in.drlario.org/install.sh' \
                        || { echo "FAIL: the LAN install one-liner is not on the page"; exit 1; }
                '''
            }
        }
    }
}
