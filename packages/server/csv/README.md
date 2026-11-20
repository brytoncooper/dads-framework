# @dads-framework/csv

Call `toCsv(rows, columns)` to export records with column headers. It produces
comma-separated cells, LF line endings, and a final newline. A column selects
a property by name, with nested paths such as `address.city` or `items[0]`.

## Cell values

The serializer quotes commas, quotes, and line breaks. Missing and null cells
are blank. Booleans produce `1` or a blank, dates use epoch milliseconds,
and structured values use JSON.
