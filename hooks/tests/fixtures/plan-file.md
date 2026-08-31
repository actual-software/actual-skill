# Add a caching layer

## Context

Read-heavy endpoints re-query on every request.

## Approach

Add a Redis cache in front of the user repository.
