# Paid API fallback and credential handling

doomlearn does not call a paid model API as a fallback, and it never takes, stores, passes or reads an API key, token, cookie or other credential. Every agent call runs a Provider's CLI under the Learner's own login, or a CLI that needs no login.

## Why this is out of scope

The Learner already pays for a subscription, and the CLI keeps its own credentials. A fallback would spend money the Learner did not choose to spend, and holding credentials would make doomlearn a target. The same rule covers usage: Usage windows come only from a CLI's own output or its documented local protocol, never from the Keychain, credential files, OAuth endpoints or cookies.

An `ANTHROPIC_API_KEY` that the Learner sets in their own environment is documented (it makes `claude -p` bill the API), but doomlearn never sets or reads it.

## Revisit if

A Provider's CLI stops working with a subscription login. Remove a section when it is implemented; delete the file when it is empty.
