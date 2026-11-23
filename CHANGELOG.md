# Changelog

Version-by-version notes for the YouTube Channel Playlist Collector. The overview is in [README.md](README.md).

## v3.59.2

When YouTube throttles requests (its "automated queries" page, HTTP 403), long runs wait 20 / 40 / 60 s and retry instead of stopping at the first refusal.

## v3.59.1

The Hololive category now means any VTuber's songs and covers (Nijisanji, VSPO, VShojo, Phase Connect, indies, ...), and the import recognises them by name.

## v3.59.0

Music library: rating strip (category letters + stars + Long / 2nd flairs) on every video, songs filed into one playlist per stars/category/flair combination with automatic roll-over at 5,000, ratings changed on the website moved on YouTube (auto every 9+ min or from 🗂 Library), playlist import with Hololive detection and duplicate tidy-up. New companion userscript `ytml-bridge.user.js`.

### v3.58.0 updates

- **☑ Select & move on playlist pages:** the floating buttons on a
  `/playlist?list=` page now include **☑ Select & move** — the same bulk mode
  as the ☑ in the watch-page side panel. Click rows to tick them (shift-click
  ticks a range), then pick a playlist and **Move** (Copy on playlists you
  can't edit) or **✕** remove. The bar sticks to the top while you scroll;
  **All** ticks only the rows loaded so far. Works with both the classic rows
  and YouTube's newer lockup rows.
- **Auto-update loaders** (`loaders/`): installed once in Tampermonkey in place
  of the full scripts, they `@require` the real files from this folder by
  `file:///` path, so every edit applies on the next page reload — no more
  copy-pasting. Needs "Allow access to file URLs" for Tampermonkey (already on
  for the bookmarks bridge). The mover extension still needs a reload in
  `brave://extensions` after it changes.

### v3.56.0 updates

- **Every playlist read stopped at 100 items** (fixed): YouTube now ends each
  page with a `continuationItemViewModel` instead of `continuationItemRenderer`,
  so uploads, exclusion lists, dedupe scans and archive reads all saw only the
  first 100. Channels with more than 100 uploads pulled since then are short.
- **Releases-only channels:** some "- Topic" channels have no uploads playlist
  at all ("The playlist does not exist"). Their songs are now read from the
  channel's Releases (album / single playlists). This is why CALLISTER pulled
  nothing: its main channel's uploads are all Shorts and its Topic had no UU list.
- **🪦 dead list:** entries are re-checked with the player before being listed
  (and when the list opens); ones that still play are dropped.
- **📥 Pull batch review tab:** candidates open one by one in a second tab with
  a top-right bar — ◀ ▶, ✓ Pull, ✕ Reject (stays put this run), 📁 Move to a
  folder — until the batch size is accepted. "Skip review" takes the first N.
- **Pull batch / New songs + duplicate skipping:** look-alikes (same title +
  length, or fuzzy) are no longer dropped silently. They are added, then 🧹
  Dedupe opens with the new playlist and your defaults ticked and the new
  playlist's copies pre-checked. Exact same-video hits and the ledger still skip.
- **▶ Compare** in Dedupe shows thumbnails and plays each side in a small
  popup window: YouTube refuses every embedded player on youtube.com itself
  (error 152-4), so the v3.55 in-dialog players never played.
- **Main↔Topic counterpart search found nothing** (v3.56.2): channel search results
  are now `lockupViewModel` (LOCKUP_CONTENT_TYPE_CHANNEL); both shapes are read.
- **Counterpart picks** (v3.56.4): among same-named channels that clearly share
  songs (≥15% overlap) the biggest one is pre-ticked, not a 100%-matching reupload
  channel; when none shares any song, none is pre-ticked.
- **Move warning:** a move that timed out is checked against the destination
  folder before being reported as failed.

### v3.55.0 updates

- **Bookmark channels:** “Skip channels named Release - Topic” is enabled by
  default and remembered between runs. Uncheck it to include those channels;
  other artists’ Topic channels remain included. Existing bookmarks are untouched.
- **Dedupe:** press **▶ Compare** on a group to open two compact video players.
  Use each selector to compare other videos in larger groups. Only one group’s
  players are loaded at a time; closing the players or dialog stops playback.
  Videos that cannot play embedded have an Open on YouTube link.
- **Quick moves:** failures show a persistent, dismissible explanation, including
  whether the destination add failed or the source removal failed after adding.
  YouTube’s error message is included when available.

A Tampermonkey userscript modeled on the "YouTube Play All" script's injection
approach, but instead of just linking to the uploads playlist it **collects
videos and adds them into an existing playlist of yours**.

## What it does

On a **channel page** you get two buttons:

- a **"⊕ Collect All"** chip in the Latest/Popular/Oldest chip bar on the
  Videos / Shorts / Live tabs (same placement as YouTube Play All), and
- a floating **"⊕ Collect channel → playlist"** button bottom-right that is
  always visible on any channel tab (guaranteed fallback).

Clicking either opens a dialog that:

1. Fetches **every upload** of the channel (uploads playlist `UC → UU`, paged
   through YouTube's internal API).
2. Fetches all releases of the **"`<Name> - Topic`" channel** if one exists.
3. **Skips** videos already present in your configured *excluded playlists*.
4. **Dedupes** exact matches only: normalized title + duration in seconds.
5. Shows a picker with **your own playlists** (same list as YouTube's native
   "Save to playlist" dialog) — pick one and the videos are **added to that
   existing playlist**, skipping anything the target already contains. You can
   also paste any playlist ID/URL, set a default target so it never asks
   again, or create a new playlist instead if you want.

On a **playlist page** the floating button becomes
**"⧉ Copy playlist → another"** — copies all videos of the current playlist
into a playlist you pick (again skipping ones already there) — plus
**"✂ Remove Shorts"**: scans the playlist for Shorts (by data tag) and any
video with a known duration under 60 seconds, shows them as a reviewable
checklist with links (all pre-checked), and removes the checked ones on
confirm — plus **"🚫 Remove a channel"** (see below). Both only work on
playlists you can edit.

## Remove one channel's videos from a playlist (🚫)

The orange **🚫 Remove a channel** floating button (playlist pages) clears
every video by a given uploader out of the playlist you're viewing — the
"I'm done with this artist" button.

It scans the playlist once and lists **the channels that are actually in
it**, sorted by how many entries each has, with a filter box for long lists.
Tick one or more, press *Show their videos →*, and you get the same
reviewable checklist as ✂ Remove Shorts (all pre-checked, titles link to the
video so you can verify) — then *Remove checked entries*. **← Pick another
channel** goes back to the list to do the next one without re-scanning, and
**↩ Undo last removal** restores the batch. Removals are journaled to 📜
History like every other removal.

**"Treat 'X - Topic' as the same channel as 'X'"** (on by default) merges an
artist's main channel with their auto-generated Topic channel into one entry,
so removing an artist takes both uploads of the same song with it.

The channel list is built from the playlist's own entries (the uploader
byline YouTube already sends with each row), so there is no channel search,
no Google Cloud project and no API key involved — and no way to pick a
channel that isn't in the playlist.

## Quick actions while watching a playlist

When **watching a video that's part of a playlist you own / can edit**, small
buttons appear on the currently-playing row of the side playlist panel:

- **✕** (always present, red) — removes the current video from the playlist
  you're watching.
- Your **configured move buttons** — e.g. `S` moves the video to *Secondary*,
  `R` to *Relax*, `1` to *Songs*: the video is added to the target playlist
  and then removed from the one you're watching. A ✓ flashes on success and
  the row fades; playback continues normally.

On playlists you **don't** own, the strip appears in **copy-only mode**: no
✕ button, and the letter buttons just add the video to their target playlist
without touching the playlist you're watching.

On a **plain watch page** (no playlist), the letter buttons appear just
above the video title — one press saves the video into that target playlist,
green means it's already there (press again to remove it).

On the **/playlist page view** every row gets the same mini strip (revealed
on hover, left of the ⋮ menu): ✕ removes the entry from the playlist you're
viewing, the letter buttons move it to their target. On playlists you can't
edit the strip is copy-only, exactly like the watch-page panel.

Buttons whose target **already contains the current song** turn green
(checked via the same signal as YouTube's native "Save to playlist" dialog;
instant for the playing video, on first hover for the all-rows mini strips).
Green buttons act as a **toggle**: pressing one removes the song from that
playlist again, and the button reverts to normal.

The **▤** button on the strip toggles **all-rows mode**: every video in the
side panel gets its own mini button strip (revealed on hover), so you can
remove/move any video in the playlist, not just the playing one. The toggle
persists across sessions.

The side panel **doesn't auto-scroll** to the playing video when the video
changes (YouTube's default). Press **◎** in the panel's action row to jump
to it.

**☑** (left of ◎) turns on **bulk select**: clicking a row ticks it instead
of playing it (shift-click ticks a range), and a bar above the list shows
**All / None**, a **Move to…** picker (your quick-action targets, then all
your playlists, or paste any URL/ID), **Move**, **✕** (remove) and **Done**.
Move adds the ticked videos to the target — skipping ones already there —
then removes them from the playlist you're watching (copy-only on playlists
you can't edit). Moves and removals are journaled like the single-video
buttons. Press ☑ again or **Done** to go back to normal clicking.

In ⚙ settings, **"Exclude Shorts when collecting / copying"** makes the
collect buttons (single & multi channel) and playlist copy skip Shorts —
detected via each channel's auto-generated Shorts playlist (`UUSH…`) plus the
Shorts tag in YouTube's new data model.

**Per-run options:** every collect (single & multi channel) starts with a
small options step — Skip duplicates (same title + length), Fuzzy matching,
Skip Shorts, Skip live streams, Skip scheduled / premieres, Skip videos I
deleted before — pre-filled from ⚙ settings but applying to that run only.

### Live, scheduled and unreleased videos

Finished live streams are found through the channel's auto-generated `UULV…`
streams playlist plus a LIVE marker in the data itself. **Scheduled** items —
a premiere, a stream planned for Friday, a countdown placeholder — are a
different problem: they are *not* in the `UULV…` playlist, and they label
themselves "Premieres Aug 30", "Scheduled for 8:00 PM" or "Waiting for…"
rather than "UPCOMING", so the old check let them straight through into
playlists as unplayable rows.

They are now caught three ways, and it takes only one to hit: the structural
`upcomingEventData` / live flags YouTube sets whatever your interface
language is; the `…LIVE…`/`…UPCOMING…`/`…PREMIERE…` badge style values; and
the badge text itself — read **only** inside status badges and thumbnail
overlays, never the title, so a video *called* "Live at Wembley" is not
mistaken for a stream.

**Skip scheduled / premieres** (on by default, ⚙ settings and per run) drops
those, and with them anything YouTube gives no duration for at all — private,
deleted and members-only placeholders that come through the uploads playlist
the same way. Shorts are exempt (the Shorts grid legitimately has no duration
badge). The log always says how many were dropped and why.

**Review the main/Topic match before it runs:** after the options step,
single-channel Collect and Collect multiple channels both resolve every
channel's uploads and search for its "`- Topic`"/main counterpart *before*
fetching anything from it — then show what was found: a ticked checkbox next
to a **link you can open to verify it's really the same artist** (untick to
leave it out of this run), or a `⚠ No … channel found for "…"` note when no
exact match exists (that channel's own uploads are collected regardless).

**Several channels with the same name? You choose.** Auto-generated Topic
channels collide on display name constantly (there really are several
distinct "Metallica - Topic" channels, belonging to unrelated uploaders).
When the search turns up more than one exact-name match, the review step now
lists **every one of them**, each with its handle, subscriber and video
counts, and *how much of its latest uploads overlap the channel you're
collecting* — the script's own best guess ticked, the rest not. Tick a
different one, or tick two if the artist genuinely has two channels; both are
collected. Nothing is fetched from any of them until you press Continue.
Nothing from the counterpart is fetched until you confirm. This is the same
review step 📥 Pull batch uses for its whole channel list (see below); if
Topic-channel matching is off in ⚙ settings there is nothing to review, so
the step is skipped automatically.

The deduper's scan has a **matching mode** choice: *Simple* (same video, or
same title + same length only; the default) or *Fuzzy* (also groups
official/lyric/audio variants).

**"Fuzzy matching when collecting"** (off by default) applies the deduper's
matching — cleaned titles, artist-dash variants, 0.8 fuzzy cutoff, ±3 s
duration guard — to the collect pipeline too: videos fuzzy-matching an
exclusion-playlist entry are skipped, main↔Topic variants are collapsed even
when their durations differ by a second or two, and videos fuzzy-matching
something already in the target playlist aren't re-added. Left off, collecting
uses exact ID / title+duration matching only — turn it on per run (the options
step) or persistently (⚙ settings) when you want the looser matching.

Configure them in ⚙ settings, one per line:

```
S | PLxxxxxxxx | Secondary
R | PLyyyyyyyy | Relax
1 | PLzzzzzzzz | Songs
2 | https://www.youtube.com/playlist?list=PLwwww | Soft songs
```

Format: `LABEL | playlist ID or URL | optional name` (label shows max 2
characters; the name is used for the hover tooltip).

The **⚙** floating button opens settings: excluded playlists as a **checkbox
list of your playlist library** (tick the ones whose videos should be skipped
when collecting; previously-configured exclusions not in your library appear
as extra ticked entries), Topic-channel on/off,
dedupe/fuzzy/Shorts/live/scheduled toggles, the deleted-video ledger
(on/off plus a review dialog), the feed check marks (on/off plus a refresh),
default target playlist, and the quick-action buttons. Settings are
stored in the browser's localStorage.

## Collect multiple channels at once (⊞)

The indigo **⊞ Collect multiple channels** floating button (channel, playlist
and library pages) opens a dialog where you paste channels one per line —
`@handle`, full channel URL, `UC…` id, or an exact channel name. Each is
resolved, its uploads (+ companion Topic/main channel) gathered, everything
combined and deduped across all of them, exclusions applied once, and the
result added to a single target playlist via the usual picker. A checkbox
lets you ignore the exclusion playlists for that run.

## New songs from your bookmarks folder (🆕)

The teal **🆕 New songs** floating button (home, channel, playlist, watch &
library pages) watches a bookmarks folder of channel links — default:
`Music/Youtube/Done/Final` in Brave's default profile — and collects every
video those channels uploaded **since your last check** into a playlist named
**"New Songs YYYY-MM-DD"** (created on first run of the day, reused if you
run it again the same day).

How it decides what's "new": for every channel it remembers the ~15 newest
video ids it saw last time (in localStorage). On the next run, everything
above the first remembered id in the uploads list is new. Remembering 15 ids
(not just 1) means a deleted video can't orphan the marker; if *none* of them
are found (mass deletions, or 250+ new videos), the channel is safely
re-baselined at its latest video instead of dumping its whole history.

A channel that appears in the folder for the **first time** is only
*baselined*: its latest video becomes the marker and nothing is collected —
the assumption is you just finished binging it, so only future uploads
matter. This also happens automatically in the background (at most once every
30 min while YouTube is open), so new bookmarks get their marker close to
when you added them. Everything else — collecting, playlist creation —
happens only when you press the button.

Channels that arrived via **📥 Pull batch** are the exception: the pull writes
their marker itself, at the moment it read their uploads, so they are already
tracked when their bookmark lands here and nothing uploaded between the pull
and your next check is missed. See *The handover to 🆕 New songs leaves no
gap* below.

The run dialog shows the bookmarks file path and folder path (editable, both
remembered) plus the usual per-run toggles: skip duplicates / fuzzy matching
(collapses the main↔Topic upload of the same song when both channels are
bookmarked), skip Shorts, skip live, and **"Skip videos already in the
excluded playlists"** — off by default, since uploads newer than your last
check are hardly ever in an exclusion playlist already and scanning them costs
a full fetch of every excluded playlist. Tick it when you've already
quick-saved some of the new songs by hand.

Markers are committed only after the videos were actually added, so a failed
or cancelled run leaves everything collectible for the next one.

### Both channels of every artist, and nothing slips past the marker (v3.37.0)

Checked against the live upload lists of all 248 watched channels on
2026-09-24, three things were costing songs:

- **Only the bookmarked channel was watched.** `Final` mostly holds one
  channel per artist — often the `- Topic` one, with the main channel's
  bookmark sitting in `100+` / `200+` / `500+`. Everything the *other* channel
  released (music videos, live versions, singles out on main first) was never
  looked at: 52 of the 59 uploads waiting that day were on such channels
  (Anson Seabra alone had 29). Now every bookmarked channel is paired with its
  main ↔ Topic **counterpart**, which is watched like a bookmark. Pairs come
  from the pull that harvested the channel, then from a name match among the
  channels already known (no request), then from a channel search — accepted
  only if the found channel shares at least one song with the bookmarked one,
  so an unrelated artist of the same name is never paired. Results are
  remembered (a miss is retried monthly); the first run does the searching and
  logs which artists have no counterpart. Toggle: *"Also watch each channel's
  main / "- Topic" counterpart"* in the run dialog. A counterpart that was
  never watched before is baselined on first sight, like a new bookmark; one
  that *was* watched before (its bookmark used to be in `Final`) is collected
  from its old marker — so the first run after upgrading can bring a backlog
  from those. Tick *Skip videos already in the excluded playlists* for that
  run if some of it is already in your library.
- **The scan stopped at the first marker it met.** A video that YouTube slots
  in *between* older uploads (published with an earlier date, a private video
  made public) sat below that point and was skipped for good. The scan now
  reads on to the deepest marker and collects everything above it that isn't
  itself a marker; the log says how many of a channel's new videos "slotted in
  below newer uploads".
- **Premieres went into the marker.** A premiere scheduled days ahead sits at
  the top of the uploads list; it was written into the marker while it
  couldn't be collected yet, so on the next run it was the first thing found —
  it was never collected, and neither was anything uploaded under it in the
  meantime. Markers now hold only videos that are actually out; a scheduled or
  duration-less one is simply "new" again next run, and collected once it has
  aired. (Same for the markers a 📥 pull writes.)

The log now also names every new video held back as "deleted before", since
that match is by title + length too: if one of them is a song you want, allow
it again in 📜 Removed videos.

### Extra setup (one-time)

Reading the local Bookmarks file needs the small companion script
`bookmarks-bridge.user.js` (the main script runs in the page context for
ytcfg access and can't touch files; the bridge runs sandboxed with
`GM_xmlhttpRequest` and answers over `postMessage` — it only ever returns
folder names + YouTube links, never your other bookmarks):

1. Tampermonkey dashboard → Create new script → paste
   `bookmarks-bridge.user.js` → save.
2. brave://extensions → Tampermonkey → **Details** → enable
   **Allow access to file URLs**.
3. Tampermonkey dashboard → **Settings** tab → set **Config mode** (top of
   the page) to **Advanced** → scroll to the **Security** section → set
   **"Allow scripts to access local files"** to **All local files** → save.
   This is Tampermonkey's own gate, separate from step 2 — without it every
   `file://` read fails with "Access to this local file is forbidden".
   (Note: it applies to all installed userscripts, so only keep scripts you
   trust.)
4. Reload the YouTube tab. The dialog's error messages point at whichever
   step is missing.

Notes: the bookmarks file is read live on every run/scan, so folder changes
are picked up immediately — but Brave writes bookmark edits to disk with a
small delay (~a few seconds, or on browser close). Clearing youtube.com site
data wipes the markers; the harmless failure mode is that every channel gets
re-baselined (no giant catch-up playlist).

## Pull a batch of bookmarked channels (📥)

The purple **📥 Pull batch** floating button takes the first N channels
(alphabetically, default 10) sitting **directly** in a bookmarks folder —
default `Music/Youtube/Done`, subfolders like `Final` are never descended
into — pulls each one's **full back catalog** into a single
**"Batch Pull YYYY-MM-DD"** playlist (created on first run of the day, reused
after that), then moves the processed bookmarks into the destination folder
(default `Music/Youtube/Done/Final`), where 🆕 New songs takes over and watches
for future uploads only. Moving bookmarks needs the companion
`bookmarks-mover-extension` (see its folder); reading them needs the same
bridge script as 🆕 New songs.

Only channels that were actually pulled have their bookmark moved — anything
that failed stays in the source folder for the next run.

### The handover to 🆕 New songs leaves no gap (v3.35.0)

Every channel the pull finishes is written into the New Songs store **during
the pull**, marked at the position its uploads feed had when the pull read it
— its ~15 newest video ids, straight from the feed before any Shorts/live
filtering. Its chosen main/Topic counterpart is marked the same way (it was
pulled in full too, and its own bookmark is usually watched separately), and
the bookmark URL → channel id the pull already resolved is cached for New
songs as well.

So the *next* 🆕 New songs run picks up **from the pull**, however many days
later it happens. Previously the moved bookmark arrived in the watched folder
unmarked, and a channel seen there for the first time is only *baselined* —
marked at whatever its latest video is at that moment, collecting nothing. Any
upload between the pull and that first sighting was therefore skipped for good.
(The background auto-scan usually shrank that window to under 30 minutes, but
only while a YouTube tab was open and the bridge was working — pull today,
check on Friday, and three days of uploads were gone.)

Two details worth knowing:

- the marker is the position at **fetch time**, not at the end of the run, so
  a video uploaded while the batch was still running is collected by the next
  New songs run rather than being lost between the two.
- a channel that already had a marker (you pulled one that was in `Final`
  already) has it **moved forward** to the pull, since the pull just took its
  whole catalog. The log says how many markers moved.

Markers are written per channel, right after its videos were added — a batch
that fails or is cancelled halfway still keeps the marks for everything it
did finish, and never marks what it didn't.

### Review step: check the main/Topic counterparts before it runs

The run happens in two phases. First it **resolves every channel in the batch
and searches for each one's counterpart** (the `- Topic` channel of a normal
channel, or the main channel of a Topic one) without adding anything. Then it
shows you the whole batch:

- every channel with its upload count, and underneath it the counterpart that
  was found — as a **link you can open to verify it's really the same
  artist**, with a **ticked checkbox**. Untick any that's a wrong match (the
  search matches on exact display name, and unrelated channels do share
  names) and its videos are left out of the run. *Untick all counterparts*
  clears them in one go.
- when **several channels share that exact name**, all of them are listed
  with their handle, subscriber and video counts and their upload overlap
  with the bookmarked channel, best guess ticked — pick the right one (or
  more than one) rather than letting the script guess for you.
- channels where **no counterpart could be found** are called out with an
  amber border and a `⚠ No topic channel found for "…"` line — those pull
  their own uploads only. The same list is repeated in the log.
- bookmarks that couldn't be resolved to a channel at all are listed too;
  they stay in the source folder.

Nothing is fetched, added or moved until you press **Pull these N
channel(s)** — closing the dialog at that point cancels the whole run
cleanly. If there's nothing to review (Topic matching turned off in ⚙
settings, and every channel resolved), the step is skipped automatically.

## Videos you deleted stay deleted (🗑 ledger)

Take a song out of a playlist and, until now, the next collect of that
channel put it right back. The **deleted-video ledger** ends that.

Every time the script does a **complete read of a playlist you can edit** —
an excluded playlist, a collect target, a playlist you scan with the
deduper — it compares what it found against a snapshot of that same playlist
from last time. Anything that has disappeared since, you removed: by hand in
YouTube's own interface, with the ✕ button, with the deduper, with 🚫 Remove
a channel. It goes in the ledger, and collects skip it from then on:

- **by video id**, always;
- **by title + length**, when *Skip duplicates* is on;
- **by fuzzy variant**, when *Fuzzy matching* is on — so deleting the
  YouTube upload of a song doesn't leave the Topic-channel upload of the same
  song free to walk back in through the other channel.

Removals the script performs itself go in immediately (it already knows the
title and channel); a deletion you made by hand is noticed on the next read
of that playlist and recorded by video id.

**A move is not a deletion (v3.37.0).** When a video has left a playlist,
the script now finds out where it went before calling it deleted: first from
the playlist archive (every playlist of yours it has read), and when that
doesn't know, by asking YouTube directly — the same lookup the *Save to
playlist* menu does, which lists every playlist of yours, read or not. Found
in another playlist → recorded as **moved** (with the destination) and never
skipped by collects. The quick-action letter buttons record their moves the
same way, destination included. Before this, only a size-capped index of
recently read playlists was consulted, so a song moved by hand into a playlist
the script hadn't read lately was recorded as deleted — roughly 500 of the
1,048 ledger entries came from the `Batch Pull …` playlists — and every
collect then skipped it. Anything the ledger still holds that a later full
read finds in one of your playlists is corrected to "moved" as well. Up to 150
missing videos per read are looked up; the rest are marked *not yet checked*
(a `?` on their badge) for the review below.

**Resuming a saved dedupe scan** re-reads its playlists and includes anything
added to them since, re-grouping so moved-in songs are checked too.
**Undo un-deletes.** ↩ in 📜 Removed videos, and *↩ Undo last removal* in
the deduper, both take the video back out of the ledger — you asked for it
back, so it becomes collectable again.

### 📜 Removed & moved videos — review any time

The **📜** button in the floating stack (also ⚙ settings → *📜 Removed
videos*) lists **every video that has left one of your playlists**: removed
with ✕, the deduper, 🚫 Remove a channel, ✂ Remove Shorts or the 🪦 cleanup;
moved with the quick buttons; or removed / moved by you in YouTube itself
(noticed the next time that playlist is read). Each row shows the date, a
badge (**✕ Removed**, **→ Moved**, **⧉ Duplicate**, **↩ Restored**), length,
title (⛔ = still skipped by collects), channel, and the playlist it left →
where it went.

Filters, all combinable: free-text search (title, channel, playlist); what
happened (removed / moved / duplicates / restored); how (which button, or "in
YouTube"); **when** (24 h, 7 / 30 / 90 days, a year, or any date range);
**playlist** (the one it left or went to, with counts); **channel** (with
counts); still skipped by collects or not; and sort order.

Actions on checked rows: **↩ Put checked back** (re-adds to the playlist it
left), **Allow re-collecting** / **Keep skipping** (take off / put on the
ledger), **🔎 Check for moves** (asks YouTube where each "removed" one is now
— with nothing checked it checks everything listed, 300 per click) and
**Delete from history**. Opening the list also corrects, for free, any
"removed" row the archive already knows to be in another playlist.

The history lives in the IndexedDB playlist archive (no 3000-row cap, no
localStorage quota). On first run the old localStorage history is imported,
along with every ledger entry it didn't explain, then deleted.

**A safety rail:** if more than half of a playlist (and more than 50 videos)
has vanished since the last snapshot, that is far more likely to be a
half-finished fetch than a deliberate purge — nothing is recorded, the log
says so, and the snapshot is refreshed so the next run diffs normally.

**Where "last time" is kept:** since v3.36.0 that snapshot is the **playlist
archive** in IndexedDB — see the next section. It holds titles as well as ids,
which is what makes the 🪦 report possible, and it costs the 5 MB
`localStorage` quota nothing.

## Videos *YouTube* deleted (🪦 + the playlist archive)

The ledger above is about deletions **you** made. This one is about the other
kind, and it needs the opposite trick.

When YouTube takes a video down, or its uploader makes it private, the entry
does **not** leave your playlist. It stays there forever as a grey row
reading `[Deleted video]` or `[Private video]` — no title, no channel, no
length. Whatever that song was is gone from YouTube at that moment, so
nothing you can ask the API afterwards will ever tell you what you lost. The
only way to know is to have written it down **before** it died.

That is the **playlist archive**. Every complete read of a playlist you can
edit — a dedupe scan, a batch pull, a collect that checks an exclusion
playlist, a ✓-marks refresh — records the id, title, length and channel of
everything that playlist held at that moment. The next read compares against
it, and any row that has turned into a tombstone since is reported **by the
name it used to have**:

```
⚠ "Songs": 3 video(s) have been deleted or made private on YouTube —
  "Nightcall" — Kavinsky, "Midnight City" — M83, "Genesis" — Justice.
  They are still sitting in the playlist — "🪦 Dead videos" reviews and removes them.
```

A **🪦 N dead** button appears in the floating stack while any are pending,
and ⚙ settings has *🪦 Videos YouTube deleted (N)*. Either opens the review
list: one row per dead entry, grouped by playlist, showing the recovered
title, channel and length, when it was first seen gone, and which kind of
death it was. From there:

- **Remove checked from their playlists** strips the tombstones out. It goes
  through the normal removal path, so 📜 **Removal history can undo it** — the
  video is gone either way, but the row comes back if you would rather keep
  the gap visible.
- **Dismiss checked** / **Dismiss all** leaves them in the playlist and stops
  listing them.

Entries already reported are not reported again on later scans, and they keep
the metadata recovered the first time — a second read of a tombstone has
nothing left to offer.

**Videos that died before the archive existed** are still detected, but can
only be listed by id: nobody wrote their titles down. From the first scan
after upgrading to v3.36.0 onward, everything is covered.

### Where it is stored

In **IndexedDB** (database `ycfp-archive`), not in `localStorage`.

That matters. Everything else the script remembers shares one ~5 MB origin
quota with YouTube's own storage, and the old id-only snapshots — capped at
40 playlists, and second in line to be evicted when the quota filled — were a
large part of what kept filling it. IndexedDB is a separate, disk-backed
store measured in hundreds of megabytes: no playlist cap, no eviction, and
nothing else has to be thrown away to make a snapshot fit. Videos are held as
compact `[id, title, seconds, channel]` arrays, roughly 70 bytes each, so a
20,000-video library is under 2 MB.

The migration is automatic and lossless: the first archived read of a
playlist seeds its "before" from the old `localStorage` snapshot (so a
deletion made across the upgrade is still caught), then deletes that snapshot
and hands the quota back. If IndexedDB is unavailable — some private-browsing
modes switch it off — the script says so and falls back to the old snapshots,
which still catch *your* deletions but cannot name YouTube's.

⚙ settings reports the archive's size and can erase it, behind a two-step
confirm: it is the only place the titles of already-dead videos still exist,
and erasing it cannot be undone from YouTube.

**Not a false positive risk:** a tombstone is recognized by `isPlayable:false`
in YouTube's own data (which survives translation into any UI language) and,
for the newer lockup layout that does not expose that flag, by the placeholder
title *combined with* a missing duration. A real upload actually called
"Deleted Video" has a duration, so it is never mistaken for a dead one.

## Check marks on songs you already have (✓)

Open a playlist that **isn't yours** — someone else's playlist, an album, a
mix, a channel's uploads list — or play one on the watch page, and every song
in it you already own gets a mark:

- **green ✓** — this exact video is in one of your playlists;
- **amber ✓** — you have *another upload of the same song*: the one a
  collect would silently skip as a duplicate.

Hovering either one says which playlist it's in. Your own playlists are never
marked (everything in them is yours by definition), and no other page is
touched.

**Rebuilt in v3.37.0.** The first version marked feeds, search, channel pages
and the sidebar everywhere, yet hardly ever showed a mark: YouTube renamed
the classes of its new "lockup" rows (`ytLockupMetadataViewModelTitle`
instead of `yt-lockup-metadata-view-model__title`), so most rows didn't match
at all, and the watch panel's doubled duration label (`4:39 4:39`) didn't
parse. It also kept its own index in localStorage (≈1.3 MB of the 5 MB
quota, rewritten after every collect). Now it runs only on the pages it is
meant for, decides each row once, computes the amber check lazily for nearby
durations only, and reads what you own from the **playlist archive** — the
same IndexedDB store every full read of your playlists already fills. The old
localStorage index is deleted on upgrade.

The marks only know playlists the script has read (collects, pulls, dedupe
scans). ⚙ settings → **✓ Read all my playlists now** reads every one of them
once (your own only — saved playlists are skipped after their first page),
which also sharpens the moved-vs-deleted check. Both marks keep their toggles
in ⚙ settings.

**The marks update live, in every tab.** Whenever anything reads or edits a
playlist — ✓ Read all, a collect, a pull, a dedupe scan — every open YouTube
tab picks up the new contents within a moment and re-checks the rows on
screen; no reload needed.

## Home feed: auto "New to you"

Opening the YouTube home feed automatically selects the **"New to you"**
chip instead of "All" (one attempt per visit — clicking back to "All" by
hand isn't fought). Toggle it off in ⚙ settings ("Home feed: auto-select
the 'New to you' chip"). If your feed doesn't show that chip at the moment
(YouTube rotates it), nothing happens.

## Playlist deduplicator (🧹)

The green **🧹 Dedupe** floating button (on channel, playlist, watch and
`/feed/playlists` pages) opens a menu that lists all playlists in your
library with checkboxes. Select the ones to scan, then it finds:

1. **Same video, multiple entries** — the exact same video kept twice in one
   playlist (or spread across the selected playlists).
2. **Same title + duration** — different video IDs that are clearly the same
   song (e.g. the normal upload vs. the Topic-channel version).
3. **Similar versions** (looser modes) — lyric video / official video /
   official audio variants. Matching is modeled on
   [ytmusic-deleter](https://github.com/apastel/ytmusic-deleter): titles are
   stripped of parentheticals and decorations ("official video", "lyrics",
   "4K", …) — round and square brackets only, since `{braces}` usually hold
   the song name rather than a decoration — "Artist - Song" titles are also
   compared by the part after the dash (`--` and en/em dashes count too, and a
   trailing `- … EP/Album` release tag is dropped), and a fuzzy score with a
   0.8 cutoff decides — plus a duration guard
   on top (which ytmusic-deleter lacks) to avoid false positives. That guard
   defaults to **±15 s** and is set in ⚙ settings (*fuzzy duration
   tolerance*); tighten it if fuzzy mode groups songs that merely run about
   as long as each other.

### Four matching modes, one scan (switch freely)

Reading your playlists is the slow part; grouping what came back is instant.
So the scan is done **once** and the four matching modes sit as buttons above
the results — click one and the same entries are regrouped under it:

| Mode | Groups together |
| --- | --- |
| **Simple** | the same video, or an identical title at the same length (±2 s). No guessing — the default. |
| **Fuzzy** | similar cleaned titles whose durations are within the ⚙ tolerance (±15 s by default). The main↔Topic uploads of one song. |
| **Similar title + same length** | similar titles, but only when the lengths match (±2 s). Stricter than fuzzy: re-uploads, not different edits. |
| **Similar titles** | similar titles with **duration ignored entirely** — finds the same song at different lengths (album cut vs single, a version with a long outro). The loosest; check these before removing. |

**Each mode keeps its own memory.** Your ticks, your per-group ✕ *unlink*
marks and the auto-pre-checked copies belong to the mode you made them in —
switching to another mode and back finds everything exactly as you left it,
and nothing you decided in one mode is overwritten by another. Removals are
the exception, and deliberately so: a removed entry shows as removed in every
mode, because it is gone from the playlist. All of it is part of the saved
scan, so a reload restores every mode you had looked at.

A mode you haven't opened yet is grouped the moment you click it — still
without re-reading a single playlist. If Simple finds nothing, the looser
modes are one click away rather than a fresh scan.

The **Similar titles** mode can't use a duration window to decide which
entries are worth comparing, so it compares entries that share a distinctive
word or opening. A word shared by more than 400 entries (boilerplate like
"official video") is skipped as a comparison key and the log says so — those
titles still match on their distinctive parts.

**The scan is saved as you go.** Every checkbox edit (individual, per-group
Check/Uncheck all, or Bulk selection) and every removal is written to
localStorage immediately. If you close the dialog or reload the page by
accident, reopening 🧹 Dedupe offers **▶ Resume last scan** — it restores the
same groups and exactly the checkboxes/removals you'd made. Resuming
re-reads the playlists the scan covered first and drops anything that is no
longer there (entries removed elsewhere, playlists deleted or emptied),
refreshing the per-entry handles at the same time, so a resumed scan can't
list entries that stopped existing after it was saved; it reports how much it
dropped. A scan older than 7 days isn't offered at all. **New scan instead**
ignores it (without deleting it — the old scan is only replaced once a new
scan actually finds duplicates), and **🗑 Discard saved scan** drops it
outright. The saved scan is also cleared automatically once every group is
resolved down to one surviving copy.

**A match isn't actually a duplicate?** Every group card has a **✕** button
top-left. Press it to unlink: the group grays out, its checkboxes are
disabled and unchecked, and the video IDs involved are written to a
persistent "unlinked" list. Every future scan (on this or any playlist)
consults that list and never groups those specific videos together again —
even a completely fresh scan skips re-forming the match, so there's nothing
to re-unlink. Press ✕ again (now showing **↺**) to re-link it. **Hide
unlinked** (next to *Hide unselected*) collapses grayed-out groups out of
view; unlinked state is also part of the saved scan, so it survives a
resume.

**Exact same video listed twice or more?** Those copies are **pre-checked
automatically** — every copy but one, so one always survives. A copy sitting
in a read-only playlist is kept as the survivor (it can't be removed anyway),
and locked entries are never checked.

**Rows marked `×3`** come from a playlist whose data carries no per-entry
handles. Its copies of a video are genuinely indistinguishable, so they are
shown as one row with a count instead of as separate entries — YouTube can
only remove them by video id, all at once. Ticking such a row on its own
means *trim to a single copy*: every copy is removed and one is added back
(at the end of the playlist — the original positions are not recoverable).
When the row is part of a bigger group and you tick it there, all of its
copies go, because a copy survives elsewhere in the group.

**Hide unselected** (button next to *Uncheck all*) collapses the results to
only the entries you've checked — groups with nothing checked disappear
entirely. Press again (*Show all*) to bring everything back; the view keeps
itself in sync as you tick boxes.

Results appear as groups. Groups whose entries come from **different
channels** are flagged with a **`*` before the `#id`** (and an amber border)
so you know to eyeball them before removing — `"<Artist>"` and
`"<Artist> - Topic"` count as the same artist, so only genuinely
cross-channel matches are starred. **Hide cross-channel** (next to *Hide
unlinked*) collapses those starred groups out of view; press again (*Show
cross-channel*) to bring them back. **Hide resolved** does the same for
groups your removals have already brought down to one entry (or none), and
keeps them hidden as you remove more. **Checked = remove** (all unchecked by
default);
titles are links (with channel names alongside) so you can verify false
positives first. Then either:

- **Manual**: check the copies you want gone and hit *Remove checked
  entries*. If any group has **every** entry checked (no copy would survive
  anywhere), a warning appears with **Revise** / **Force continue** — total
  removal only happens deliberately.
- **Bulk selection**: pick a playlist and hit *Select its duplicate entries*
  — its duplicates get checked, keepers stay unchecked, and it **never**
  checks a whole group (one copy always survives). **Cross-channel groups
  (the starred `*` ones) are left completely unchecked** — different artists
  are the likeliest false matches, so you review those by hand. Review, then
  *Remove checked entries*. An *Uncheck all* button resets your marks.

Matching improvements (also used by the collector's fuzzy skip):

- **Different renditions never merge.** An instrumental is not treated as a
  duplicate of the vocal version, and live / acoustic / remix / sped-up /
  slowed / cover / piano / 8D / demo / extended / radio-edit versions each
  stay separate from the original — even when the cleaned titles are
  identical. ("Live" is detected conservatively — `(live…)`, `live at/from…`,
  `- live` — so a song merely containing the word "live" isn't affected.)
- **The artist's name is stripped from the title** before comparing (using
  the channel/uploader name, with `- Topic` reduced to the artist), so
  `Gracie Abrams - Close To You` and the Topic channel's bare `Close To You`
  match on the song title itself.
- **A main channel and its `- Topic` are grouped in preference to unrelated
  channels.** Same-artist fuzzy matches use the normal 0.8 cutoff; matches
  between *different* artists need a much stricter 0.92, so borderline
  cross-channel look-alikes don't get pulled together (identical-title
  cross-channel matches still group, but they're starred and left unchecked
  in bulk-select for you to review).
- **Durations no longer need to match closely.** The fuzzy duration slack is
  configurable in ⚙ settings (default **15 s**, was a fixed 3 s). Set it to 0
  to require an exact match, or raise it (max 120 s) to catch versions with
  different intros/outros.
- **Titles are fully normalized**: accents are folded (`Café` = `Cafe`,
  `Beyoncé` = `Beyonce`) and every symbol and punctuation mark is removed, so
  only letters and digits are compared.
- **Oversized fuzzy groups are auto-split.** A group covering more than 5
  distinct videos is almost always a false cluster glued together by shared
  boilerplate (e.g. `FREE EMOTIONAL PIANO TYPE BEAT`). The deduper drops the
  words shared by ≥60% of the group's videos, re-clusters on the distinctive
  words that remain, and keeps only the entries that still match — so those
  bogus mega-groups break back apart (logged in the dialog). If removing the
  shared words leaves an entry with nothing at all, the title is re-read with
  its brackets kept (`Chan (Fire Storm)` → `Fire Storm`) rather than falling
  back to the shared form, which used to re-merge the group on the spot. Only
  entries that are still empty after that stay together — so eight uploads
  genuinely called `Wildflower` remain one group, while eight songs that only
  share a channel name do not. Each surviving chunk is re-split the same way
  (up to 3 rounds), in case it carries a second layer of boilerplate.

After any removal an **↩ Undo last removal** button restores the batch, and
every removal (dedupe, ✂ Shorts, quick-action ✕/moves) is journaled: the
**📜 History** button (next to ⚙) lists them with per-entry ↩ undo. Restored
videos are re-added at the end of their playlist (positions can't be kept).
History lives in localStorage, capped at 3000 entries.

The floating button stack has a **−** button at the bottom that collapses it
to a single ☰ button (state persists); click ☰ to expand again.

Read-only playlists (saved from other users, albums) are shown with a 🔒 and
never touched. Removal targets the exact playlist entry where possible, so
removing one copy of a video doesn't nuke the other copy in the same playlist.

## Bookmark deduplicator (🔖)

The amber **🔖 Bookmark dupes** floating button (everywhere) finds bookmarks
that point at the **same channel written in different forms** — the case that
started this:

```
https://www.youtube.com/@BRDGS
https://www.youtube.com/channel/UCfUY1Y60grOtUOvI__biIlg
```

Pick a folder from the dropdown and it scans **that folder and every
subfolder under it** (unlike 📥 Pull batch, which reads the top level only).
Two options: *look up @handle links via YouTube* (needed to match
`@handle` ↔ `/channel/UC…`; results are cached in the same URL→id map 🆕 New
songs fills, so only the first scan is slow) and *YouTube links only* (uncheck
to also catch identical non-YouTube bookmarks).

Grouping mirrors the playlist deduplicator's tiers, keyed on the channel
instead of the video:

1. **Same resolved `UC…` id** — what pairs an `@handle` link with a
   `/channel/UC…` one.
2. **Same link form + name** — `@BRDGS` ↔ `@brdgs/videos`, no API call
   needed.
3. **Same normalized URL** — protocol, `www.`/`m.`, trailing slash and
   tracking params ignored (`?v=`/`?list=` are kept, since those decide what
   the link points at). This is what catches plain double-bookmarks.

There is **no fuzzy tier**: two links either point at one channel or they
don't.

**The preferred link is kept.** `@handle` beats `/c/` beats `/user/` beats
`/channel/UC…`; between equals the most canonical spelling wins
(`https://www.youtube.com/@Ghost` over `http://m.youtube.com/@ghost/`, the
bare channel page over a deep link into its `/videos` tab). Every other link
in the group is **pre-checked for deletion**, and one link per group always
survives unless you force it. **↺ Prefer @handle links** re-applies that
default at any time.

Groups whose links resolved to **different channels** are starred ★ with an
amber border and left entirely unchecked — same treatment cross-channel
groups get in the playlist deduper.

Each row shows the link form (`@`, `UC`, `/c/`, `/u/`), the bookmark title,
the URL, and **the subfolder it lives in**. At the bottom, *Select every
duplicate link from one folder* checks all of one folder's duplicate links in
one go — with the same guard the playlist deduper's bulk-select uses: a group
with nothing outside that folder keeps its first link, so this can never wipe
a channel entirely.

**Deleting always asks first**, listing what's about to go, and afterwards
**↩ Undo last deletion** puts the bookmarks back in their original folder and
position. If you'd rather not delete at all, *Move checked there instead*
parks them in a folder of your choice.

Needs the companion `bookmarks-mover-extension` at **v1.1.0+** (the
read-only bridge script can't delete anything) — if yours is older the dialog
says so; reload it in `brave://extensions`.

## Bookmark the channels in playlists (📌)

The teal **📌 Bookmark channels** floating button (everywhere, v3.48.0) is
the old standalone `yt-channel-bookmark-sync` extension folded in. It no
longer needs a YouTube Data API key, and it reads private playlists too,
because it uses the same logged-in internal API as everything else here.

1. Tick playlists from your library and/or paste other playlists (URLs or
   ids, one per line). Both are remembered for next time.
2. Pick the **search folder**. A channel counts as already bookmarked if it
   is anywhere in that folder **or any subfolder under it**. The target
   folder is always searched too, so a target outside the search folder
   never gets the same channel twice.
3. Pick the **target folder** where new bookmarks go.

Every channel that owns at least one video in those playlists is checked
against the bookmarks. **Every link form counts as the same channel:**

- `/channel/UC…`, including sub-pages like `/channel/UC…/videos`, is compared
  by id. This needs no lookup.
- `@handle` is compared with the channel's own handle from the playlist data
  when YouTube supplies it. Otherwise it is resolved to its `UC…` id.
- Legacy `/c/Name` and `/user/Name` links are resolved to their `UC…` id.
- `http://`, `m.youtube.com`, a trailing slash or a deep link into a tab
  makes no difference.

Lookups use the same strict resolver as 🔖 Bookmark dupes, never a name
search, and share the URL→id cache with 🆕 New songs and 🔖. Most links are
therefore already known. Lookups only run while some channel is still
unmatched, and the links whose title names one of those channels go first.
The run stops looking up links as soon as every channel has matched.

The review lists two groups, each row showing how many of the playlists'
videos belong to that channel:

- **Not bookmarked**: ticked by default.
- **Counterpart already bookmarked**: the channel's main ↔ "- Topic"
  counterpart is bookmarked, either as a pair already known from New songs or
  Pull batch, or as the other kind of channel with the same artist name.
  These rows are unticked, so ticking them is up to you. (Final mostly holds
  Topic bookmarks while main channels live in `100+`/`200+`/`500+`, so this
  is a common case.)

New bookmarks are titled `<Channel> - YouTube`, matching what the browser
itself saves. Their link is the channel's `@handle` when the playlist data
gives one, else `/channel/UC…`, which is the case for every Topic channel and
for most rows in YouTube's newer playlist layout. Each new URL→id pair goes
straight into the shared cache. **↩ Undo** removes the bookmarks just added.
Re-running is always safe.

Needs `bookmarks-mover-extension` **v1.2.0+**, which adds the `addBookmarks`
request. Reload the extension in `brave://extensions` after updating.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. **Chrome/Edge only:** userscripts need extra permission —
   Tampermonkey → Manage extension → enable **Developer mode** (Chrome) or
   **Allow user scripts** toggle, then reload the extension. *Without this,
   scripts silently never run — the most common reason "the button doesn't
   appear".*
3. Tampermonkey dashboard → Create new script → paste the full contents of
   `channel-full-playlist.user.js` → save.
4. Reload YouTube, open any channel while **logged in**.

## Troubleshooting "button doesn't appear"

- Check the Tampermonkey icon shows a red "1" on youtube.com (script active).
- Chrome: confirm the "Allow User Scripts" / Developer mode toggle (step 2).
- Open DevTools console and look for errors mentioning `ycfp`.
- The floating button appears on channel pages (`/@name`, `/channel/…`) and
  playlist pages only — not on the home page or watch pages.

v1 of this script used `innerHTML`, which YouTube's Trusted Types security
policy silently blocks — that's why its panel never showed. v2 builds all UI
with plain DOM calls and re-injects on an interval (YouTube aggressively
erases DOM changes), the same strategy YouTube Play All uses.

## Robustness (v3.6)

- Rate limits (HTTP 429/503) are retried automatically with 15/30/45 s
  backoff before giving up; a run that still fails is always safe to re-run
  (already-added videos are skipped, removals re-scan from current state).
- Add/remove batches that don't return success now **stop the run with an
  error** instead of pretending they worked — nothing is struck through or
  counted unless YouTube confirmed it.
- "Same title + duration" matching tolerates ±2 s everywhere, because
  YouTube's two data models report durations for the same video slightly
  differently (exact seconds vs the rounded thumbnail badge).
- Fuzzy matching never compares the after-dash part of two titles against
  each other (for "Song - Artist" naming that part is the artist, which
  falsely grouped different songs by one artist).
- Quick-move buttons check whether the target already contains the video
  before adding (retries can't create duplicates), and ✕ removes only the
  specific playlist entry when YouTube exposes its per-entry handle.
- Exclusion playlists are cached for 15 minutes per session instead of being
  re-downloaded on every collect run.
- **v3.29.0:** channels whose uploads playlist renders as a Shorts grid
  (`shortsLockupViewModel`, seen on channels that upload only — or almost
  only — Shorts) parsed as **0 videos** even though the uploads existed;
  the item-list scanner didn't recognize that renderer. Fixed — Shorts-grid
  entries are now parsed like any other upload (title + video id; no
  duration badge is exposed in this UI, so they're matched by video id only,
  same as live/upcoming entries).
- **v3.30.0:** single-channel Collect and Collect multiple channels now show
  the "review the main/Topic match" step Pull batch had — see *Review the
  main/Topic match before it runs* above.
- **v3.32.0:** a **full browser store no longer breaks a run**. Everything
  the script remembers shares one ~5 MB quota with YouTube itself, and the
  big caches (a saved dedupe scan of 20k+ entries, the feed-mark index) can
  fill it. A write that overflowed used to throw at whichever caller was
  unlucky — merely remembering which playlists you had ticked aborted the
  whole dedupe run with *"exceeded the quota"* before it had scanned
  anything. Now every write goes through one helper that, on a full store,
  drops the most expendable cache and retries: playlist snapshots first,
  then moved-video notes, the feed-mark index, the removal history, and only
  last the saved dedupe scan. It says in the dialog what it dropped, and it
  never throws — a full store costs at most the one thing that write was
  trying to remember. Your settings, exclusions, quick actions, the
  deleted-video ledger and the bookmark/new-songs state are never dropped:
  nothing on YouTube can rebuild them. Two related fixes: a saved dedupe
  scan with nothing left outstanding is now deleted the next time the
  deduper opens (it was never offered to you again, but sat there holding
  megabytes for a week), and ⚙ settings has a **🧹 Clear cached data** button
  showing what the script currently stores.
- **v3.33.0:** the **feed-mark index no longer fills the store**, and the
  eviction order changed. The ✓ marks kept their index as JSON and re-parsed
  and rewrote the whole thing on every change — once per 50-video batch
  during a collect — which at the 20 000-video cap meant 3–4 MB of a 5 MB
  quota, plus megabytes of throwaway strings per run. It is now held parsed
  in memory and written back debounced (once at the end of a collect), stored
  as tab-separated rows rather than JSON with playlist ids interned and the
  version key as a bitmask, and capped by size as well as by row count:
  **2.9 MB → 1.3 MB** for the same 20 000 videos, measured. Your existing
  index is imported on upgrade, so no marks are lost. Eviction now drops **the
  saved dedupe scan first** — it is the biggest single thing stored and
  re-running a scan is one button — then playlist snapshots, the feed-mark
  index, moved-video notes, and **the removal history last**: the two records
  of things that already happened are the last to go.

- **v3.35.0:** 📥 **Pull batch now hands over to 🆕 New songs without a gap.**
  A pull takes a channel's whole back catalog and then moves its bookmark
  into the watched folder — but nothing recorded *where* the catalog ended,
  so the channel was only baselined when New songs (or its 30-min auto-scan)
  next saw the bookmark, and a first sighting collects nothing. Everything
  uploaded in between was silently skipped: pull on Monday, run New songs on
  Friday, and Tuesday-to-Thursday's uploads were gone. The pull now writes
  each finished channel's marker itself — the ~15 newest ids from its uploads
  feed, read before Shorts/live filtering, at the moment it fetched them —
  along with its chosen main/Topic counterpart and the bookmark URL → channel
  id it already resolved. Markers are written per channel right after its
  videos were added (a half-finished batch keeps what it finished), a channel
  that already had a marker has it moved forward to the pull, and the
  fetch-time position means a video uploaded *during* the run is caught next
  time rather than falling between the two.
- **v3.34.0:** the fuzzy modes stopped **merging different songs that share a
  channel**. Three separate causes, all fixed:
  1. `{braces}` were stripped like `(…)` and `[…]`, so
     `cornandbeans--{Fire Storm}` and `cornandbeans--{Blaze}` both compared as
     the bare word `cornandbeans` — every upload on such a channel collapsed
     into one group. Braces now keep their contents, and `--`/en-dash titles
     split into artist and song like `Artist - Song` already did.
  2. "one title contains the other" scored 0.9 however much extra text there
     was, so `Shadow` matched `Shadow - Burning Ground EP` and, through it,
     the unrelated song `Burning Ground`. Containment now only counts when the
     longer title is at most 40% longer, and a trailing release segment
     (`- … EP/LP/Album/Single`) is dropped when a song name sits before it.
  3. the oversized-group splitter fell back to the **full** title whenever
     removing the shared words emptied an entry — re-merging the group it had
     just taken apart. See *Oversized fuzzy groups are auto-split* above for
     what it does instead.

- **v3.36.0:** the snapshot of each playlist moved to **IndexedDB and now
  holds titles**, which buys two things. Videos **YouTube** deleted (or whose
  uploader made them private) are detected and **reported by the name they
  used to have** — their rows stay in your playlist as anonymous
  `[Deleted video]` placeholders forever, and the title is unrecoverable from
  YouTube once it happens, so the archive is the only record. A **🪦 N dead**
  button appears while any are pending; it lists them with title, channel,
  length and playlist, and removes the ones you tick (undoable from
  📜 Removal history). And the snapshots stop competing for the ~5 MB
  `localStorage` quota: they were capped at 40 playlists and second in line
  for eviction, and are now in a disk-backed store with no cap, so nothing
  else has to be dropped to fit them. Existing snapshots are migrated on the
  first read of each playlist — the diff carries across, then the old copy is
  deleted and the quota handed back. See *Videos YouTube deleted* above.
- **v3.37.0:** 🆕 **New songs watches both channels of each artist** (main ↔
  Topic counterparts, found once and remembered), no longer stops reading at
  the first marker, and keeps premieres out of its markers — see *Both
  channels of every artist* above. **Moves are no longer recorded as
  deletions:** a video that left a playlist is looked up in your other
  playlists (archive first, then YouTube's own Save-to-playlist membership)
  before it goes on the ledger. **📜 Removed & moved videos** replaces the
  old history and ledger lists, with filters for time, playlist, channel,
  type and source; its history moved into IndexedDB. The **✓ marks** only
  run on playlists that aren't yours, work with YouTube's renamed lockup
  rows, and read from the archive; the 1.3 MB localStorage index is gone.
  After updating, **reload every open YouTube tab** — the archive database
  gets a new store, and a tab still running the old version holds that
  upgrade up until it is reloaded.
- **v3.39.1:** a run can no longer **freeze silently** (seen in 🧹 at
  "Songs: 4743 videos…"). YouTube requests time out after 45 s and retry;
  the playlist archive gives up after 20 s and falls back; a playlist whose
  continuation pages keep repeating stops after three empty pages (and that
  read is kept out of the deletion diff, since it may be incomplete). The log
  now says when it is updating the archive and checking where missing videos
  went, so a slow step is visible rather than looking stuck.
- **v3.40.0:** 🧹 dedupe has a **Hide resolved** toggle that hides groups
  already down to one remaining entry (or none) after removals. It updates
  after each removal and each undo.
- **v3.40.2:** 📜 history's ↩ works on **moved** rows: it puts the video back
  in the playlist it left and takes it out of the one it moved to.
- **v3.41.0:** new **⊘ Unavailable** button: pick playlists, and every
  unavailable entry in them (deleted, private, blocked — including the ones
  YouTube hides behind "Show unavailable videos") is listed with its old
  title from the archive, then moved into one "Unavailable videos" playlist
  (reused if it exists, created private if not). Entries YouTube refuses to
  add stay put unless you tick "remove them anyway". Undo in the dialog or
  from 📜 history.
- **v3.41.1:** if ⊘ Unavailable can't move some videos, their links (with
  title, channel, playlist, and whether they're still there) are saved as
  `youtube-unavailable-not-moved_<date>.txt` in your Downloads folder.
- **v3.42.0:** ⊘ Unavailable reworked — it now **removes** the unavailable
  entries (deleted/private videos usually can't be added to any playlist, so
  the old "move" left most of them in place). Adding them to an "Unavailable
  videos" playlist is an optional best-effort extra. Both steps are verified
  by reading the playlists back, and **every** removal (here and in 🪦 Dead
  videos) saves `youtube-unavailable-removed_<date>.txt` to Downloads with
  each link, title, channel, playlist, whether it was really removed, and
  where it was added. Hidden unavailable videos are un-hidden via the
  playlist's own "Show unavailable videos" switch, with yt-dlp's parameter as
  a fallback, and the log says so if YouTube still hides some. Per-entry
  removals now send the video id alongside the entry handle, as ytmusicapi
  does.
- **v3.42.1:** ⊘ Unavailable found nothing on playlists whose unavailable
  videos YouTube hides: in the data those rows look completely normal
  (playable, titled, with a length — typically blocked in your country), so
  no marker could catch them. Now the playlist is read twice, normally and
  with "Show unavailable videos", and whatever only the second read has is
  listed as "hidden by YouTube".
- **v3.43.0:** 📜 history has **💾 Save listed as txt**: every row the
  current filters match (not just the ones on screen) goes to
  `youtube-history-<filter>_<date>.txt` in Downloads — date, removed/moved,
  link, title, channel, length, playlist, where it moved to, and how. Pick
  "Removed" in the first filter for the list of videos you deleted.
- **v3.43.1:** ⊘ Unavailable now **always** reads each playlist a second
  time with unavailable videos shown. It used to do that only when YouTube
  showed the "Unavailable videos are hidden" banner or the "Show unavailable
  videos" menu item — but on Songs (4998 entries) YouTube hid 169 entries,
  including 10 deleted/private ones, with neither sign present, so nothing
  was found there.
- **v3.44.0:** ⚙ settings has **📥 Import dedupe unlinks**: load a text file
  of video ids that 🧹 dedupe should never group again. A line "a b" unlinks
  that pair (every pair, for more ids); "a b | c d" keeps a↔b and c↔d linked
  and unlinks every pair across the "|". Lines starting with # are ignored.
  Merged into the saved unlinks; nothing is removed.
- **v3.45.0:** storage is no longer capped at ~10 MB. localStorage has a
  fixed ~10 MB per-site limit (shared with YouTube) that no browser setting
  raises, so everything but the settings — the deleted-video ledger, dedupe
  unlinks, the saved 🧹 scan, snapshots, moved notes and the new-songs /
  batch-pull / bookmark-dupes state — now lives in a disk-backed IndexedDB
  store (`ycfp-kv`) with room for gigabytes. It is moved over automatically
  on the first load and then deleted from localStorage. The script loads it
  into memory before starting, writes back within a quarter second (at once
  when the tab is hidden or closed), keeps open YouTube tabs in sync, and
  asks the browser to keep the store persistent. ⚙ settings shows both sizes.
- **v3.46.0:** three fuzzy-matching fixes, found by scanning ~15,700 real
  playlist entries:
  - **"Song - Artist" titles:** the part after the dash is no longer used as
    a song name when it is the uploader's own name, and a title that strips
    down to one character ("K. - Cigarettes After Sex") keeps it. Together
    these had linked every "… - Cigarettes After Sex" upload (1,332 pairs).
  - **Numbered series:** titles whose numbers differ (neither set inside the
    other) never match — "Idea 7" ≠ "Idea 12", "atom 1" ≠ "atom 10",
    "Pt. 1" ≠ "Pt. 2"; "Symphony No. 5" still matches "… No. 5, Op. 67".
    Applies to the deduper and to fuzzy collecting.
  - **Type beats:** '… Type Beat - "Name"' is compared on the quoted name
    alone (the producer's boilerplate made ~1,570 different beats look
    alike), and a type beat never merges with a non-beat of the same name.
- **v3.54.0:** 📥 Pull batch also bookmarks the main/Topic counterparts you
  ticked: an existing bookmark of one anywhere under
  `Bookmarks Bar/Music/Youtube` (any link form, e.g. in `100+`) is moved into
  `Done/Final`; one with no bookmark gets a new one there. Needs the mover
  extension v1.2.0+.
- **v3.53.2:** Clicking or dragging the progress bar to skip ahead no
  longer pauses the video (the "keep paused" fix took YouTube's scrub pause
  for yours).
- **v3.53.1:** 🔗 Add / remove links also sees the videos YouTube hides
  as unavailable (it read "Unavailable videos" as empty and refused).
- **v3.53.0:** 🧹 dedupe ticks are fast again and the "Storage is full"
  warnings are gone. A 15,000-entry scan is ~11 MB; it used to be
  re-serialized and cloned into every open YouTube tab on each checkbox
  click. Edits are now saved 1.5 s after the last one (at once when the tab
  is hidden, closed or the scan is reopened), and big values only send the
  other tabs a "re-read" notice. If the browser closes the disk store under
  a tab it is reopened and rewritten from memory instead of falling back to
  localStorage (which the scan alone overflows), a slow cold start gets 60 s
  instead of 10 s to open it, and a value too big for localStorage is
  reported once — with the reason the disk store is not open — instead of
  on every tick, and no longer evicts the other caches trying to fit.
  Long scans no longer crawl in a background tab: the loops' "let the page
  breathe" pauses used timers, which a hidden tab runs once a second (once
  a minute after 5 minutes hidden); they now use a MessageChannel message,
  which is not throttled. Request pacing between pages still uses timers.
  New **🔗 Add / remove links** button on playlist pages: paste video links
  or ids, then add them to the playlist you are viewing (videos already in
  it are skipped) or remove them from it (every copy). Meant for staging
  lists such as Available replacements and Unavailable videos.
- **v3.52.1:** 🧹 dedupe unlinks hold in every scan: two videos you
  unlinked (✕ or 📥 import) no longer end up in one group again through a
  third video that matches both of them.
- **v3.52.0:** a video you pause while the page is still loading stays
  paused: YouTube's player no longer restarts it once loading finishes. A
  click on the video / play button or k / space that the not-yet-ready
  player ignores counts as a pause too. Any play that doesn't come from a
  new click or key press is undone for 60s after the pause.
- **v3.51.0:** **📺 Binge → Watch later** (floating button). Adds every
  video bookmarked under `Bookmarks Bar/See asap/Binge Videos` (all
  subfolders except `Deleted`) to Watch later, removing the bookmarks batch
  by batch. Dead links, and dead entries already in Watch later, get a
  replacement search with a pick-one review (close title matches
  pre-picked). No replacement: a dead bookmark moves to
  `Binge Videos/Deleted`; a dead Watch later entry is bookmarked there under
  its archived name, then removed from Watch later. Needs the Bookmarks
  Mover extension **v1.3.0** (new `ensureFolder` request) — reload it.
- **v3.50.4:** removals from **Available replacements** stay off the
  deleted-video ledger too, like Watch Later (old entries are dropped).
- **v3.50.3:** 📌 bookmark channels: the target folder defaults to the
  search folder, and a saved path differing only in case
  ("Bookmarks bar/…") picks the listed folder.
- **v3.50.2:** a 🪦 dead entry is taken off the list when a later full read
  finds the video playable again (one glitched read used to leave playable
  videos listed as dead for good).
- **v3.50.1:** the separate "Default playlists" list from v3.50.0 is gone.
- **v3.50.0:** the **excluded playlists** (⚙ settings) double as your
  default playlists. When any are ticked, 🪦 dead videos are only tracked in
  those, and the dedupe / remove unavailable / bookmark-channels pickers get
  a **Select default** button that ticks exactly them.
- **v3.49.1:** removals from Watch Later never go on the deleted-video
  ledger (and old Watch Later entries are dropped from it).
- **v3.49.0:** **☑ bulk select** in the side playlist panel's action row
  (beside ◎): tick several videos, then move / copy / remove them in one go.
- **v3.47.0:** the side playlist panel no longer jumps to the playing video
  every time the video changes. YouTube's auto-scroll is switched off, and a
  **◎** button in the panel's action row (right of loop / shuffle) scrolls
  the playing video into the middle of the list on demand.

## Notes & limitations

- Desktop only (m.youtube.com is not supported).
- Playlists cap at 5,000 videos; the script computes remaining room in the
  target and truncates with a warning if needed.
- The companion channel is found by exact-title search and works both ways:
  on a normal channel it looks for `"<name> - Topic"`, and on a Topic channel
  it strips the suffix and looks for the main channel. If no exact match
  exists it's skipped (logged).
- Videos without a duration (upcoming/live) are never title-deduped, only
  exact video-ID matched, so nothing is falsely merged.
- Uses YouTube's internal InnerTube API with your session — the same requests
  the site itself makes. If YouTube changes internals, the dialog will show a
  clear ❌ error and the script needs updating.
