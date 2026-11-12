# Running the LCQ

For whoever holds the tablet. Setup and the laptop side are in the [README](README.md).

The LCQ is single elimination: lose once and you are out. There is no draw: players who are free and on the same number of wins are paired as they come free, longest waiting first.

## Open the runner

On a tablet on the booth Wi-Fi, open the address and PIN shown on the admin page (`http://100.64.0.2/lcq`). If a sign-in sheet appears when joining the Wi-Fi, choose to stay connected. The tablet stays signed in until the server restarts, and updates itself every few seconds.

Each game has its own tab. **Event** at the top (once there is more than one event) shows an earlier event's results and winners; only the current event can be run.

## Run a game

1. **Start a match.** **Ready to play** lists the pairs on the same wins, longest waiting first. Tap **Start**. To pair two people yourself, open **Pick a match**: Against lists only players on the Player's wins; tick **Any wins** to pair across wins.
2. **Record the winner.** In **Playing**, tap the winner's button (A or B). The result shows at the top with **Undo** until the next change. In **Results**, Undo shows on a result only while neither player has a later one; undo the later one first. **Call off** cancels a match that has no result (started by mistake).
3. **Fill the bracket.** It comes out even when the number of players is a power of 2 (8, 16, 32), so the tab says how many more sign-ups make it full: "24 in the bracket: need 8 more for a full bracket of 32."
4. **LCQ Finalize** when sign-ups for this game close. It fixes who is in; a bracket that is not full needs a tick, as some players will need a Bye. Anyone who signs up after it is told the bracket is full and is counted on the tab; **LCQ Unfinalize** lets them in.
5. **Bye.** Once finalized, a player left alone on their wins with nobody below who could catch up shows in **Needs attention** with a **Give (name) a Bye** button: one win without a match. Undo it like a result.
6. **LCQ End** (at the bottom) when the game is done: no match may be on, and a tick is needed if players are still in. It shows the Winner (the player or players on the most wins still in), makes the tab read-only and closes that game's LCQ sign-ups on the guest form. **Reopen** (with a tick) undoes it.

## When something is off

- **Someone has gone:** **Needs attention** lists long waits and long matches. Their number is on their row in **Standings** and **Find a player**. **Drop** on the row (tick "not here" first) takes a no-show out; a match they are in goes to the opponent.
- **A wrong result:** Undo it. Matches started after it on the wrong record are called off, and the page says which; a later result must be undone first.
- **Two players stuck on different wins:** use **Pick a match** with **Any wins**, or give the lone one a Bye once finalized.

## The bracket

**Rounds** (folded while playing, open once ended) draws the bracket: a column per round, each match with its winner marked W, and a line from each winner to the match they played next or to where they are waiting. Because pairings are made as people come free, the lines show who really played whom, not a draw made in advance. Once finalized, each round says how many matches are still to come, and the last one in shows as the Winner. On a phone it scrolls sideways.
