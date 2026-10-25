# World Top Songs

A globe for exploring each country's weekly music chart and playing its tracks.

## Charts

**Chart source**:
YouTube's official weekly music charts — the only source of chart data.
_Avoid_: Spotify, kworb, scrape

**Charted country**:
A country for which the chart source publishes a weekly chart.
_Avoid_: supported country

**Uncharted country**:
A country with no official weekly chart. It stays selectable and shows an explicit notice that no official chart exists for it; it is never filled with another country's data or a fabricated list.
_Avoid_: unsupported country, fallback

**Chart**:
The current weekly ranking of a country's most popular music, in two kinds: songs and videos.

**Chart week**:
The week a chart covers as declared by the chart source, not the time it was fetched.

**Track**:
One ranked entry in a chart: the recording, its artists, and its position movement.

**Movement**:
How a track's rank changed since the previous chart week: new, up, down, or unchanged.

**Provenance**:
Whether chart data is live (fetched from the chart source) or stale (the last good copy). A chart is never presented as live when it is not.
_Avoid_: source, fallback

## Globe

**Country**:
A territory drawn on the globe and identified by its ISO 3166-1 alpha-2 code. Every country is selectable, charted or not.
_Avoid_: nation, market

**Region**:
A grouping of countries used to filter the globe. Regions are not countries.
_Avoid_: continent

**Selection**:
The country the user has chosen, or none. It drives the chart surface, the globe highlight and the camera focus.
_Avoid_: active country, current country

**Hover**:
The country under the pointer. It is transient, never persisted, and distinct from selection.

**Focus**:
The camera movement applied to a selection: it centres the country and may move closer, but never increases the viewing distance.
_Avoid_: fly-to, zoom

**World view**:
The neutral camera state showing the whole globe with nothing focused.

**Region rail**:
The row of region filter chips.
_Avoid_: rail (on its own)

## Playback

**Queue**:
A snapshot of a chart's tracks taken when playback starts. It outlives changes of country and tab.
_Avoid_: playlist

**Now playing**:
The queue entry whose video is currently loaded in the player.

## Layout

**Chart panel**:
The chart surface on wide layouts, docked at the side of the globe.
_Avoid_: sidebar, rail

**Chart sheet**:
The chart surface on narrow layouts, occupying part of the screen.

**Peek**:
The chart sheet's folded state: a single summary bar.

## Design

**Calm**:
The design principle that colour and motion carry state only — hover, selection, playback — with no decorative animation or glow.
_Avoid_: minimal (it does not mean featureless)
