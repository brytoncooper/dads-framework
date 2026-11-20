# @dads-framework/clock — time as a seam

The `Clock` abstract class and its system implementation. Anything that
needs "now" takes a `Clock` in its constructor, so tests inject fixed time
and logic never reaches for `Date.now()` ambiently.
