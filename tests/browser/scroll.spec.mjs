import { selectCommunity } from "./navigation.mjs";
import { test, expect, historySize } from "./fixture.mjs";
import { streamEvidence } from "./stream-evidence.mjs";

import {
  settle,
  anchor,
  expectAnchor,
  end,
  open,
  upper,
  edge,
  toOlder,
  virtuaIdle,
  wheel,
} from "./timeline.mjs";

// Background communities connect after a random start delay, so their startup
// reads can land in any window. Count only the community under test.
const primaryQueries = (app) =>
  app.report.queries.filter(({ community }) => community === "primary").length;
const primaryRowQueries = (app) =>
  app.report.queries.filter(
    ({ community, filter }) =>
      community === "primary" &&
      !(filter.include_aux && !filter.include_summaries),
  ).length;

test.use({ historyCounts: { alpha: 640, beta: 80 } });
// Keep non-paging reading gestures outside the unchanged near-top read zone,
// even with a 20-row head. The cursor journey below keeps ordinary-height rows.
const readingTest = test.extend({ tallMessages: true });
const editTest = readingTest.extend({
  streamEvidence: [streamEvidence, { auto: true }],
});

const rowSelector = "[data-message-id]";
const history = (page) =>
  page.getByRole("region", { name: "Channel message history" });
const button = (page, name) => page.getByRole("button", { name, exact: true });
const composer = (page, name) =>
  page.getByRole("textbox", { name: `Message #${name}`, exact: true });

async function expectOutsidePrefetch(page) {
  const distance = await history(page).evaluate(
    (el) => el.scrollTop - Math.max(3000, el.clientHeight * 4),
  );
  expect(
    distance,
    "reading position is outside the older-page zone",
  ).toBeGreaterThan(0);
}

async function observeWork(page) {
  await page.evaluate(() => {
    const sample = {
      frames: [],
      longTasks: [],
      maxRows: 0,
      maxDomNodes: 0,
      maxTimelineNodes: 0,
      maxTimelineStructureNodes: 0,
      active: true,
      frame: 0,
    };
    window.browserPerformanceSample = sample;
    let last;
    const tick = (now) => {
      if (!sample.active) return;
      if (last !== undefined) sample.frames.push(now - last);
      last = now;
      sample.maxRows = Math.max(
        sample.maxRows,
        document.querySelectorAll("[data-message-id]").length,
      );
      sample.maxDomNodes = Math.max(
        sample.maxDomNodes,
        document.getElementsByTagName("*").length,
      );
      for (const timeline of document.querySelectorAll(
        "[data-message-scroller]",
      )) {
        const nodes = timeline.getElementsByTagName("*").length;
        sample.maxTimelineNodes = Math.max(sample.maxTimelineNodes, nodes);
        // Keep SVG roots (icon instances), but separate library-owned artwork
        // primitives from the row/control structure's growth budget.
        sample.maxTimelineStructureNodes = Math.max(
          sample.maxTimelineStructureNodes,
          nodes - timeline.querySelectorAll("svg *").length,
        );
      }
      sample.frame = requestAnimationFrame(tick);
    };
    sample.frame = requestAnimationFrame(tick);
    sample.longTaskSupported =
      PerformanceObserver.supportedEntryTypes.includes("longtask");
    if (sample.longTaskSupported) {
      sample.observer = new PerformanceObserver((list) =>
        sample.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        ),
      );
      sample.observer.observe({ type: "longtask" });
    }
  });
}
async function workSample(page) {
  return page.evaluate(() => {
    const sample = window.browserPerformanceSample;
    sample.active = false;
    cancelAnimationFrame(sample.frame);
    sample.observer?.disconnect();
    const frames = sample.frames.toSorted((a, b) => a - b);
    return {
      frameSamples: frames.length,
      p95FrameMs: frames[Math.floor(frames.length * 0.95)] ?? null,
      maxFrameMs: frames.at(-1) ?? null,
      longTaskSupported: sample.longTaskSupported,
      longTasks: sample.longTasks,
      maxMountedRows: sample.maxRows,
      maxDomNodes: sample.maxDomNodes,
      maxTimelineNodes: sample.maxTimelineNodes,
      maxTimelineStructureNodes: sample.maxTimelineStructureNodes,
    };
  });
}

readingTest(
  "real scrolling preserves reading intent over append, community/channel switches and reload",
  async ({ page, app }) => {
    await open(page, app);
    await composer(page, "Alpha").fill("A draft");
    const saved = await upper(page);
    await expectOutsidePrefetch(page);
    // No direct service calls or view-state preparation. Real UI cleanup saves it.
    for (let cycle = 0; cycle < 3; cycle++) {
      await button(page, "Beta").click();
      await composer(page, "Beta").waitFor();
      await button(page, "Alpha").click();
      await settle(page);
      await expectAnchor(page, saved);
      await selectCommunity(page, "Secondary");
      await composer(page, "Alpha").waitFor();
      await expect(composer(page, "Alpha")).toHaveJSProperty(
        "value",
        cycle ? "B draft" : "",
      );
      // A warm geometry cache can mask a lost anchor until cold reload. Check
      // the real unmount write, not only today's coincidentally matching offset.
      const persisted = await page.evaluate(() => {
        const key = Object.keys(localStorage).find((key) => {
          if (!key.startsWith("buzz-view.v1:")) return false;
          const [scope, view] = JSON.parse(key.slice("buzz-view.v1:".length));
          return (
            scope.startsWith("https://primary.example:") &&
            view === "scroll:alpha"
          );
        });
        return key ? JSON.parse(localStorage.getItem(key)) : null;
      });
      expect(persisted?.anchor?.id).toBe(saved.id);
      await composer(page, "Alpha").fill("B draft");
      await selectCommunity(page, "Primary");
      await expect(composer(page, "Alpha")).toHaveJSProperty(
        "value",
        "A draft",
      );
      await settle(page);
      await expectAnchor(page, saved);
    }
    expect(app.report.sessions.toSorted()).toEqual(["primary", "secondary"]);
    // Each community keeps one stream; discovered interests update that owner
    // in place. Repeated channel/community switches must not churn either.
    // Every joined community connects at startup, so their order is a race.
    const byCommunity = (entries) =>
      entries.toSorted((a, b) => a.community.localeCompare(b.community));
    expect(byCommunity(app.report.streamConnections)).toEqual([
      { community: "primary", channels: [] },
      { community: "secondary", channels: [] },
    ]);
    expect(byCommunity(app.report.streamInterests)).toEqual([
      { community: "primary", channels: ["alpha", "beta"] },
      { community: "secondary", channels: ["alpha", "beta"] },
    ]);
    const savedOffset = await history(page).evaluate((el) => el.scrollTop);
    await page.reload();
    await composer(page, "Alpha").waitFor();
    await settle(page);
    await expectAnchor(page, saved);
    // Cold geometry can change the absolute offset; the same visible message is the contract.
    const reloadedAnchor = await anchor(page);
    app.report.measurements.push({
      scenario: "reload",
      savedOffset,
      before: saved,
      after: reloadedAnchor,
    });
    await expect(composer(page, "Alpha")).toHaveJSProperty("value", "A draft");

    await observeWork(page);
    const held = app.append("primary", "alpha");
    // Positive receipt evidence before claiming that "no jump" means correctness.
    await expect(
      history(page).locator(`[data-message-id="${held.id}"]`),
    ).toBeAttached();
    await settle(page);
    await expectAnchor(page, reloadedAnchor);
    const jumpToLatest = history(page).locator("button[data-jump-to-latest]");
    await expect(jumpToLatest).toBeVisible();
    await expect(jumpToLatest).toHaveCSS("border-radius", "34px");
    await expect(jumpToLatest.locator("..")).toHaveCSS("border-radius", "34px");
    await jumpToLatest.focus();
    await page.keyboard.press("Enter");
    await expect(history(page)).toBeFocused();
    await expect(
      history(page).locator(`[data-message-id="${held.id}"]`),
    ).toBeInViewport();
    await expect(jumpToLatest).toHaveCount(1);
    await expect(
      jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
    ).toHaveAttribute("inert", "");
    await expect(
      jumpToLatest.locator("xpath=ancestor::*[@data-visible][1]"),
    ).toHaveAttribute("aria-hidden", "true");
    await expect(
      history(page).getByRole("button").and(jumpToLatest),
    ).toHaveCount(0);
    await expect(jumpToLatest).toBeHidden();
    const followed = app.append("primary", "alpha");
    await expect(
      history(page).locator(`[data-message-id="${followed.id}"]`),
    ).toBeInViewport();
    await settle(page);
    await expect
      .poll(() =>
        history(page).evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(4);
    app.report.measurements.push({
      scenario: "live-appends",
      ...(await workSample(page)),
    });
    // Visits left read-ahead reads cancelled; only the reader now at the
    // latest message may still be reading ahead.
    expect(
      app.pending.filter(
        (read) => !(read.community === "primary" && read.channel === "alpha"),
      ),
    ).toEqual([]);
  },
);

// Browser boundary: successful sends must not replay their reveal instruction
// over Virtua's saved message/Y when the real sidebar remounts a conversation.
const sendTest = readingTest.extend({
  productionBroker: true,
  historyCounts: { alpha: 20, beta: 1 },
});
sendTest(
  "a prior send preserves the reading anchor on return, while a fresh send reveals",
  async ({ page, app }) => {
    await open(page, app);
    const input = composer(page, "Alpha");
    const publications = () =>
      app.report.publications.filter(({ event }) => event.kind === 9);
    await input.fill("First sent message");
    await input.press("Enter");
    await expect.poll(() => publications().length).toBe(1);
    await expect(
      history(page).locator(
        `[data-message-id="${publications()[0].event.id}"]`,
      ),
    ).toBeInViewport();
    await expect(input).toHaveJSProperty("value", "");
    const saved = await upper(page);
    await expectOutsidePrefetch(page);
    await button(page, "Beta").click();
    await composer(page, "Beta").waitFor();
    await button(page, "Alpha").click();
    await settle(page);
    await expectAnchor(page, saved);
    app.report.measurements.push({
      scenario: "send-then-return",
      before: saved,
      after: await anchor(page),
    });
    await input.fill("Fresh send from reading position");
    await input.press("Enter");
    await expect.poll(() => publications().length).toBe(2);
    await expect(
      history(page).locator(
        `[data-message-id="${publications()[1].event.id}"]`,
      ),
    ).toBeInViewport();
    await settle(page);
    await expect
      .poll(() =>
        history(page).evaluate(
          (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
        ),
      )
      .toBeLessThan(4);
  },
);

readingTest(
  "returning to a channel read at its latest message never offers Jump to latest",
  async ({ page, app }) => {
    await open(page, app);
    const visit = async (name) => {
      await button(page, name).click();
      await composer(page, name).waitFor();
      await settle(page);
    };
    // Open both channels once, so each later visit returns to a saved latest place.
    await visit("Beta");
    await visit("Alpha");
    // Register before switching: the button may show and hide within one frame.
    await page.evaluate(() => {
      window.jumpShown = 0;
      new MutationObserver((records) => {
        for (const record of records)
          if (record.target.getAttribute("data-visible") === "true")
            window.jumpShown++;
      }).observe(document.body, {
        attributes: true,
        attributeFilter: ["data-visible"],
        subtree: true,
      });
    });
    for (let cycle = 0; cycle < 2; cycle++) {
      await visit("Beta");
      await visit("Alpha");
    }
    await expect
      .poll(() =>
        history(page).evaluate(
          (element) =>
            element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThan(4);
    expect(await page.evaluate(() => window.jumpShown)).toBe(0);
  },
);

test("cursor paging preserves visible anchors and keeps a large history virtualized", async ({
  page,
  app,
  browserName,
}) => {
  const ahead = await open(page, app);
  await observeWork(page);
  let loaded = 20 + ahead.reduce((rows, read) => rows + read.events.length, 0);
  const cursors = new Set(
    ahead.map(({ filter }) => `${filter.until}:${filter.before_id}`),
  );
  while (loaded < historySize) {
    // A small prepend can leave us inside the prefetch zone and automatically
    // request the next page. A new gesture must not duplicate that pending read.
    expect(app.pending.length).toBeLessThanOrEqual(1);
    const alreadyPending = app.pending.length === 1;
    const queriesBeforeWheel = primaryRowQueries(app);
    if (alreadyPending) {
      await history(page).hover();
      const offset = await history(page).evaluate(
        (element) => element.scrollTop,
      );
      if (offset >= 4) await wheel(page, -Math.min(400, offset));
      else {
        await page.mouse.wheel(0, -1);
        await settle(page);
      }
    } else {
      await toOlder(page, app, { top: false });
    }
    await expect
      .poll(() => app.pending.length, {
        message: "wheel triggers production cursor read",
      })
      .toBe(1);
    expect(app.pending).toHaveLength(1);
    if (alreadyPending) expect(primaryRowQueries(app)).toBe(queriesBeforeWheel);
    const before = await anchor(page);
    const height = await history(page).evaluate(
      (element) => element.scrollHeight,
    );
    const pending = app.pending.shift();
    expect(pending.community).toBe("primary");
    expect(pending.channel).toBe("alpha");
    expect(pending.filter.until).toBeDefined();
    expect(pending.filter.before_id).toMatch(/^[a-f0-9]{64}$/);
    // Pages are sized to the reader's pace, within the relay's read limit.
    expect(pending.filter.limit).toBeGreaterThanOrEqual(20);
    expect(pending.filter.limit).toBeLessThanOrEqual(200);
    const cursor = `${pending.filter.until}:${pending.filter.before_id}`;
    expect(cursors.has(cursor), "each older cursor is requested once").toBe(
      false,
    );
    cursors.add(cursor);
    expect(pending.events).toHaveLength(
      Math.min(pending.filter.limit, historySize - loaded),
    );
    pending.release();
    loaded += pending.events.length;
    await expect
      .poll(() => history(page).evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(height + Math.min(500, pending.events.length * 40));
    // Positive receipt: the page committed and its aux closure is read next.
    // Rows can sit outside the 1,600px virtual buffer while paging from the
    // prefetch zone.
    await expect
      .poll(() =>
        app.report.queries.some(
          ({ filter }) =>
            filter.include_aux &&
            !filter.include_summaries &&
            filter.until === pending.filter.until &&
            filter.before_id === pending.filter.before_id,
        ),
      )
      .toBe(true);
    await settle(page);
    await expectAnchor(page, before);
    expect(
      await history(page).locator(rowSelector).count(),
    ).toBeLessThanOrEqual(100);
    expect(app.pending.length).toBeLessThanOrEqual(1);
  }
  expect(loaded).toBe(historySize);
  // Each page's aux closure is read apart from its rows.
  expect(
    app.report.queries.filter(
      ({ filter }) =>
        filter.until !== undefined &&
        !(filter.include_aux && !filter.include_summaries),
    ),
  ).toHaveLength(cursors.size);
  expect(app.pending).toHaveLength(0);

  await edge(page, -1);
  const first = app.histories.get("primary/alpha")[0];
  await expect(
    history(page).locator(`[data-message-id="${first.id}"]`),
  ).toBeInViewport();
  // Return to the tail through the app's own jump control before establishing
  // an above-bottom reading anchor: Linux WebKit caps each wheel gesture near
  // 1.5k px, so wheeling all 640 rows back down exceeds edge()'s gesture cap.
  const latest = app.histories.get("primary/alpha").at(-1);
  const jumpToLatest = page.getByRole("button", { name: "Jump to latest" });
  await expect(jumpToLatest).toBeVisible();
  await jumpToLatest.click();
  await expect(
    history(page).locator(`[data-message-id="${latest.id}"]`),
  ).toBeInViewport();
  await virtuaIdle(page);
  const saved = await upper(page);
  const savedOffset = await history(page).evaluate(
    (element) => element.scrollTop,
  );
  const expectReading = () => expectAnchor(page, saved);
  // The long signature exceeds the unchanged 256KiB geometry-cache cap.
  // Restore the visible message, even when cold estimates cannot reach the old offset.
  // Heap is Chromium-only, diagnostic, and sampled after GC at an equivalent
  // warm route; never present unsupported WebKit metrics as zero.
  const cdp =
    browserName === "chromium"
      ? await page.context().newCDPSession(page)
      : undefined;
  const heap = async () => {
    if (!cdp) return null;
    await cdp.send("HeapProfiler.collectGarbage");
    return cdp.send("Runtime.getHeapUsage");
  };
  await button(page, "Beta").click();
  await composer(page, "Beta").waitFor();
  await button(page, "Alpha").click();
  await settle(page);
  await expectReading();
  const heapBefore = await heap();
  const switches = [];
  for (let i = 0; i < 5; i++) {
    await button(page, "Beta").click();
    await composer(page, "Beta").waitFor();
    const start = performance.now();
    await button(page, "Alpha").click();
    await expectReading();
    switches.push(performance.now() - start); // Includes automation round trips.
    await settle(page);
  }
  const heapAfter = await heap();
  await cdp?.detach();
  const uncachedRestoration = {
    savedOffset,
    before: saved,
    after: await anchor(page),
  };
  const reading = await anchor(page);
  const beforeAppendHeight = await history(page).evaluate(
    (element) => element.scrollHeight,
  );
  const receipt = app.append("primary", "alpha");
  // The restored upper offset must still mean "do not follow". Receipt becomes
  // positively visible at the start of the retained-history traversal below.
  await expect
    .poll(() => history(page).evaluate((element) => element.scrollHeight))
    .toBeGreaterThan(beforeAppendHeight);
  await settle(page);
  await expectAnchor(page, reading);
  const queriesBeforeTraversal = primaryQueries(app);
  await end(page);
  await expect(
    history(page).locator(`[data-message-id="${receipt.id}"]`),
  ).toBeInViewport();
  await history(page).hover();
  // Collect mounted IDs on every animation frame while wheeling upward in
  // <1,600px steps so adjacent mounted ranges overlap without paying a full
  // settle() geometry-quiet wait on each of ~70 scan steps.
  const scanner = await history(page).evaluateHandle((element, selector) => {
    const ids = new Set();
    let wheels = 0;
    let scrolled = false;
    let ended = false;
    let raf = 0;
    const record = () => {
      for (const row of element.querySelectorAll(selector)) {
        const id = row.dataset.messageId;
        if (id) ids.add(id);
      }
    };
    const tick = () => {
      record();
      raf = requestAnimationFrame(tick);
    };
    const onWheel = () => {
      wheels += 1;
      scrolled = false;
      ended = false;
    };
    const onScroll = (event) => {
      if (event.target !== element) return;
      scrolled = true;
    };
    const onScrollEnd = (event) => {
      if (event.target !== element) return;
      record();
      ended = true;
    };
    record();
    raf = requestAnimationFrame(tick);
    element.addEventListener("wheel", onWheel, { passive: true });
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("scrollend", onScrollEnd, { passive: true });
    return {
      state: () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => {
            record();
            resolve({ wheels, scrolled, ended, top: element.scrollTop });
          }),
        ),
      finish: () => {
        cancelAnimationFrame(raf);
        element.removeEventListener("wheel", onWheel);
        element.removeEventListener("scroll", onScroll);
        element.removeEventListener("scrollend", onScrollEnd);
        record();
        return [...ids];
      },
    };
  }, rowSelector);
  let seen;
  let pendingRead;
  const readState = () => {
    const read = scanner.evaluate((api) => api.state());
    pendingRead = read;
    return read;
  };
  try {
    for (let step = 0; step < 200; step++) {
      const before = await readState();
      if (before.top < 4) break;
      // Less than the 1,600px buffer: adjacent mounted ranges overlap.
      await page.mouse.wheel(0, -1400);
      await expect
        .poll(
          async () => {
            const after = await readState();
            return (
              after.wheels > before.wheels &&
              (after.top < 4 || (after.ended && after.scrolled))
            );
          },
          { intervals: [16], message: "retained-history scan wheel advances" },
        )
        .toBe(true);
    }
    await settle(page);
    seen = new Set(await scanner.evaluate((api) => api.finish()));
  } finally {
    await pendingRead?.catch(() => {});
    await scanner.evaluate((api) => api.finish()).catch(() => {});
    await scanner.dispose();
  }
  await expect(
    history(page).locator(`[data-message-id="${first.id}"]`),
  ).toBeInViewport();
  for (const event of app.histories.get("primary/alpha"))
    expect(seen.has(event.id), `retained ${event.content.split("\n")[0]}`).toBe(
      true,
    );
  expect(primaryQueries(app)).toBe(queriesBeforeTraversal);
  // Each Beta visit's read-ahead was cancelled when the reader left.
  expect(app.pending).toHaveLength(0);
  const sample = await workSample(page);
  expect(sample.frameSamples).toBeGreaterThan(0);
  expect(sample.maxMountedRows).toBeLessThanOrEqual(100);
  // Structural growth guard, not a heap-leak claim. 640 unvirtualized rows
  // would exceed both limits; bounded rows must hold during movement too.
  // Count only the timeline, so sidebar growth cannot mask or trip it.
  // Main at 69a9af23 has 1573 raw / 1410 structure nodes in both engines.
  // Preserve its eight-node allowance; retain the raw count in the report.
  expect(sample.maxTimelineStructureNodes).toBeLessThan(1418);
  app.report.measurements.push({
    scenario: "640-row-paging-and-switches",
    retainedRows: loaded,
    ...sample,
    switchRoundTripMs: switches,
    heapBefore,
    heapAfter,
    uncachedRestoration,
    retainedIdsObserved: seen.size,
  });
});

editTest(
  "live edits follow the bottom without stealing a reader's message anchor",
  async ({ page, app }) => {
    await open(page, app);
    await end(page);
    await expectOutsidePrefetch(page);
    const queriesBefore = primaryQueries(app);
    const event = app.append("primary", "alpha", "Short message before edit");
    const row = history(page).locator(`[data-message-id="${event.id}"]`);
    await expect(row).toBeInViewport();
    await settle(page);
    app.edit(
      "primary",
      "alpha",
      event,
      "Live edit growing the last row. ".repeat(300),
    );
    await expect(row).toContainText("Live edit growing");
    await settle(page);
    await expect
      .poll(() =>
        history(page).evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(4);
    // Return to short content, then read above it; edits must not act like a send.
    app.edit(
      "primary",
      "alpha",
      { ...event, created_at: event.created_at + 1 },
      "Short again",
    );
    await expect(row).toContainText("Short again");
    await settle(page);
    await expect
      .poll(() =>
        history(page).evaluate(
          (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
        ),
      )
      .toBeLessThan(4);
    const saved = await upper(page);
    await expectOutsidePrefetch(page);
    app.edit(
      "primary",
      "alpha",
      { ...event, created_at: event.created_at + 2 },
      "Growing while reading history. ".repeat(300),
    );
    await expect(row).toContainText("Growing while reading");
    await settle(page);
    await expectAnchor(page, saved);
    // Remeasure a buffered row wholly above the viewport. A partly visible
    // row is still being read: Virtua deliberately does not compensate its size.
    const previousId = await history(page).evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      return [...el.querySelectorAll("[data-message-id]")].findLast(
        (row) => row.getBoundingClientRect().bottom <= top,
      )?.dataset.messageId;
    });
    const previous = app.histories
      .get("primary/alpha")
      .find((event) => event.id === previousId);
    expect(previous).toBeDefined();
    const previousRow = history(page).locator(
      `[data-message-id="${previous.id}"]`,
    );
    const previousHeight = await previousRow.evaluate(
      (row) => row.getBoundingClientRect().height,
    );
    expect(
      await previousRow.evaluate(
        (row) =>
          row.getBoundingClientRect().bottom -
          row.closest("section").getBoundingClientRect().top,
      ),
    ).toBeLessThanOrEqual(0);
    app.edit(
      "primary",
      "alpha",
      previous,
      `${previous.content}\n${"An expanded message above the reading anchor. ".repeat(50)}`,
    );
    await expect(previousRow).toContainText("An expanded message");
    await settle(page);
    expect(
      await previousRow.evaluate((row) => row.getBoundingClientRect().height),
    ).toBeGreaterThan(previousHeight);
    await expectAnchor(page, saved);
    app.edit(
      "primary",
      "alpha",
      { ...previous, created_at: previous.created_at + 1 },
      previous.content,
    );
    await expect(previousRow).not.toContainText("An expanded message");
    await settle(page);
    await expectAnchor(page, saved);
    await expectOutsidePrefetch(page);
    expect(primaryQueries(app)).toBe(queriesBefore);
  },
);
