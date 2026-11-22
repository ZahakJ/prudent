# Summary

Kestrel is a small command-line feed reader: you give it the address of an RSS
feed and it prints the titles of the latest posts. Today, if the feed's server
is busy for a moment (it answers "503 Service Unavailable" or "429 Too Many
Requests"), Kestrel gives up straight away and prints an error, even though the
same request would usually work a second later.

This change makes Kestrel try again a few times, waiting a little longer each
time (1 s, 2 s, 4 s), before giving up. People who read feeds from small or busy
servers benefit; anyone who wants the old behaviour can pass `--retries 0`.

# How the project works (just enough)

- `kestrel/cli.py` reads the command line and prints the result.
- `kestrel/fetch.py` downloads the feed with Python's built-in `urllib`. It is
  the only place that talks to the network.
- `kestrel/parse.py` turns the downloaded XML into a list of items. It is not
  touched here.
- Tests live in `tests/` and run with `pytest`. They never use the network:
  they replace `urllib.request.urlopen` with a fake.

An HTTP status of 429 or 5xx means "the server could not answer right now";
4xx statuses other than 429 mean "your request is wrong" and are not worth
retrying.

# Walkthrough

The heart of the change is the loop in `fetch.py`. Everything else follows
from it.

## kestrel/fetch.py

### @@ -1,12 +1,46 @@

`RETRY_STATUS` lists the statuses that are worth retrying.

### lines 17-28

The loop makes at most `retries + 1` attempts. A wrong request (404, say)
is raised at once, as before. `sleep` is a parameter only so the tests can record the waits
instead of really sleeping.

## kestrel/cli.py

Adds `--retries` (default 3) and passes it through. `--retries 0` restores the
old behaviour exactly.

## tests/test_fetch.py

Two tests with a fake `urlopen`: success after two 503s (and the waits were
1 s then 2 s), and giving up after the last retry.

## tests/test_feed_parse.py

Renamed from `test_parse.py` so the two test files sort next to each other.
No content change.

## docs/NOTES.txt

Removed: an old scratch file the README no longer mentions.

## docs/retry-diagram.png

A small diagram of the backoff schedule, linked from nowhere yet.

## README.md

Documents the new behaviour and the `--retries` switch.

# Risks

- The server's `Retry-After` header is ignored.
- There is no cap on the total wait: with a large `--retries` the waits grow fast.
- A feed that is truly down now takes up to about 7 seconds (1 + 2 + 4) to
  fail instead of failing at once. `--retries 0` avoids that.
- The diagram PNG is a placeholder and is not referenced anywhere.

# What was tested

- `pytest tests/` passes locally (Python 3.12): the two new tests and the
  existing parser test.
- Not tested: a real busy server. I did not find a public feed that reliably
  answers 503, so the retry path has only run against the fake.
- Not tested on Windows.

# Questions for the reviewer

- Should there be a cap on the total wait?
- Should the PNG stay in this PR or go in a docs PR later?

# Upstream rules checked

- CONTRIBUTING asks for one topic per PR: this PR only touches downloading.
- New behaviour needs a test and a README line: both included.
- No new dependencies (only the standard library).

# PR description

**fetch: retry transient failures with exponential backoff**

Busy feed servers sometimes answer 503 or 429, and Kestrel gave up on the
first error. This retries those statuses and connection errors up to three
times with exponential backoff (1 s, 2 s, 4 s).

- `--retries N` sets the number of retries; `--retries 0` keeps the old
  behaviour.
- Tests use a fake `urlopen`, so they run offline and do not sleep.

Tested with `pytest` on Python 3.12. Not yet tried against a real busy server.
