// CodaiPro website — reveal-on-scroll, live star count, real poll.
// The poll stores votes as JSON in the visitor's own browser (localStorage).
// No accounts, no cookies, no backend. Everything degrades gracefully: without
// JS the page still reads fine, and the star count keeps a static fallback.

(function () {
    "use strict";

    var REPO = "Luckyyaduvanshiofficial/Codaipro";
    var CACHE_MS = 10 * 60 * 1000; // be kind to the unauthenticated rate limit

    document.documentElement.classList.add("js");

    // localStorage can throw outright when cookies/site data are blocked
    var LS = (function () {
        try {
            var t = window.localStorage;
            t.setItem("__codaipro_test", "1");
            t.removeItem("__codaipro_test");
            return t;
        } catch (e) {
            var mem = {};
            return {
                getItem: function (k) { return Object.prototype.hasOwnProperty.call(mem, k) ? mem[k] : null; },
                setItem: function (k, v) { mem[k] = String(v); },
                removeItem: function (k) { delete mem[k]; }
            };
        }
    })();

    function cacheGet(key) {
        try {
            var raw = LS.getItem(key);
            if (!raw) return null;
            var parsed = JSON.parse(raw);
            return parsed;
        } catch (e) {
            return null;
        }
    }

    function cacheSet(key, value) {
        try {
            LS.setItem(key, JSON.stringify(value));
        } catch (e) {
            /* private mode or quota — non-fatal */
        }
    }

    /* ----------------------------------------------------------------------
       Footer year
       ---------------------------------------------------------------------- */

    var year = document.getElementById("year");
    if (year) year.textContent = String(new Date().getFullYear());

    /* ----------------------------------------------------------------------
       Live star count in the hero chip
       ---------------------------------------------------------------------- */

    var chipText = document.getElementById("gh-chip-text");

    if (chipText) {
        var starsCache = cacheGet("codaipro-stars");

        var paintStars = function (n, forks) {
            chipText.innerHTML =
                "<strong>★ " + n + "</strong> stars" +
                (forks != null ? " · " + forks + " forks" : "") +
                " on GitHub — add yours";
        };

        if (starsCache && Date.now() - starsCache.t < CACHE_MS) {
            paintStars(starsCache.stars, starsCache.forks);
        } else {
            fetch("https://api.github.com/repos/" + REPO)
                .then(function (r) { return r.ok ? r.json() : null; })
                .then(function (d) {
                    if (!d || typeof d.stargazers_count !== "number") return;
                    cacheSet("codaipro-stars", {
                        t: Date.now(),
                        stars: d.stargazers_count,
                        forks: d.forks_count
                    });
                    paintStars(d.stargazers_count, d.forks_count);
                })
                .catch(function () { /* keep the static fallback text */ });
        }
    }

    /* ----------------------------------------------------------------------
       Poll — votes stored locally as JSON in this browser (localStorage)
       ---------------------------------------------------------------------- */

    var POLL_OPTIONS = [
        { label: "Qwen3.5-0.8B" },
        { label: "Gemma 3 1B" },
        { label: "Qwen2.5-Coder-3B" },
        { label: "Qwen2.5-Coder-7B" },
        { label: "Something else" }
    ];
    var POLL_KEY = "codaipro-poll"; // { votes: {label: n}, mine: label }

    var resultsBox = document.getElementById("poll-results");
    var totalEl = document.getElementById("poll-total");
    var rowsEl = document.getElementById("poll-rows");
    var optionButtons = document.querySelectorAll(".poll-option");

    function pollLoad() {
        var state = cacheGet(POLL_KEY);
        if (!state || typeof state !== "object") state = {};
        if (typeof state.votes !== "object" || state.votes === null) state.votes = {};
        return state;
    }

    function renderPoll(state) {
        var total = 0;
        POLL_OPTIONS.forEach(function (opt) {
            total += state.votes[opt.label] || 0;
        });

        resultsBox.hidden = false;
        totalEl.textContent =
            total === 0
                ? "No votes yet from this browser — yours will be the first."
                : "Your local tally: " + total + (total === 1 ? " vote" : " votes") +
                  " from this browser" + (state.mine ? " · your pick: " + state.mine : "");

        rowsEl.innerHTML = "";
        POLL_OPTIONS.forEach(function (opt) {
            var count = state.votes[opt.label] || 0;
            var pct = total > 0 ? Math.round((count / total) * 100) : 0;

            var li = document.createElement("li");
            li.className = "poll-row";

            var label = document.createElement("span");
            label.className = "poll-label";
            label.textContent = opt.label;
            if (opt.label === state.mine) {
                var yours = document.createElement("span");
                yours.className = "yours";
                yours.textContent = " — your pick";
                label.appendChild(yours);
            }

            var countEl = document.createElement("span");
            countEl.className = "poll-count";
            countEl.textContent = String(count);

            var track = document.createElement("span");
            track.className = "poll-track";
            var fill = document.createElement("span");
            fill.className = "poll-fill";
            track.appendChild(fill);

            li.appendChild(label);
            li.appendChild(countEl);
            li.appendChild(track);
            rowsEl.appendChild(li);

            // animate in on the next frame
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    fill.style.width = (pct || (count > 0 ? 2 : 0)) + "%";
                });
            });
        });
    }

    var pollState = pollLoad();

    // Mark the remembered choice
    optionButtons.forEach(function (btn) {
        if (btn.getAttribute("data-poll-label") === pollState.mine) {
            btn.classList.add("is-voted");
        }
    });

    if (pollState.mine) {
        renderPoll(pollState);
    }

    optionButtons.forEach(function (btn) {
        btn.addEventListener("click", function () {
            var label = btn.getAttribute("data-poll-label");
            var state = pollLoad();
            if (state.mine === label) return; // same pick, nothing to move

            // Moving the vote: take one back from the old choice
            if (state.mine && state.votes[state.mine]) {
                state.votes[state.mine] -= 1;
                if (state.votes[state.mine] <= 0) delete state.votes[state.mine];
            }
            state.votes[label] = (state.votes[label] || 0) + 1;
            state.mine = label;
            pollSave(state);

            optionButtons.forEach(function (b) {
                b.classList.toggle("is-voted", b.getAttribute("data-poll-label") === label);
            });
            renderPoll(state);
        });
    });

    /* ----------------------------------------------------------------------
       Reveal on scroll
       ---------------------------------------------------------------------- */

    var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    var targets = document.querySelectorAll(
        ".hero-copy, .sheet, .section-head, .syllabus-list li, " +
        ".option, .models, .venues-list li, .letter"
    );

    if (reduced || !("IntersectionObserver" in window)) return;

    targets.forEach(function (el) { el.classList.add("reveal-init"); });

    var observer = new IntersectionObserver(
        function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) return;

                var el = entry.target;
                // Stagger siblings that arrive together; human jitter, not metronome.
                var siblings = Array.prototype.filter.call(
                    el.parentNode.children,
                    function (c) { return c.classList.contains("reveal-init"); }
                );
                var index = siblings.indexOf(el);
                el.style.transitionDelay = (Math.max(index, 0) % 6) * 70 + "ms";

                el.classList.add("is-in");
                observer.unobserve(el);
            });
        },
        { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
    );

    targets.forEach(function (el) { observer.observe(el); });
})();
