# Whiteout brand

**The mark** is a bold W whose upper half breaks into horizontal blizzard streaks:
the whiteout. In the notch at its base it holds the relic, a sealed tile turned on its
corner. The streak gaps widen toward the top, so the letter dissolves into the storm.

**The wordmark** is "whiteout" in lowercase Saira (weight 720, width 112%, tracking
-0.015em). The dot of the i is the relic.

| File | Use |
| --- | --- |
| `mark.svg` | Primary mark on light backgrounds |
| `mark-on-dark.svg` | On navy or photography |
| `app-icon.svg` | Favicon and app icon (rounded navy tile) |
| `app-icon-square.svg` | Source for platforms that mask their own corners (iOS) |
| `logo-sheet.png` | Overview: mark, wordmark, on dark, icon sizes |

## Construction

48-unit grid. Four strokes, each 8.4 units wide, each running 8.4 across over 32 down,
mirror-symmetric about x = 24. Solid bands from the top: 8-10.2, 12.4-14.6, 16.3-18.6,
19.8-22.2, then solid from 22.9 to 40. The relic is a 3.7-unit square, radius 0.6,
rotated 45 degrees about (24, 36.6).

| Colour | Hex |
| --- | --- |
| Ink | `#0d1b2a` |
| Glacier | `#2f7fb5` |
| Ice | `#7cc0ea` |
| Relic amber | `#f0b43a` |

Keep clear space of half the mark's width on every side. Don't outline the mark, fill
the streak gaps, or recolour the relic.
