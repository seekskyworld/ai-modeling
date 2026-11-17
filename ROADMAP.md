# Roadmap

The project focuses on useful, verifiable CLI and MCP access to Studio. This roadmap sets priorities rather than delivery dates or a promise of complete equivalence with another backend.

## Public project maintenance

- Keep installation, configuration, examples and release packages reproducible.
- Expand platform validation where real operating-system credential stores and browser behavior can be tested.
- Keep dependency updates, security reports and compatibility regressions actionable through the contribution workflow.

## Compatibility

- Investigate the complete preparation, submission and result chain for remaining official CLI mappings.
- Add verified Studio capabilities using the existing command conventions.
- Validate actual artifacts and requested effects, rather than treating accepted parameters or successful task statuses as full equivalence.

The [current compatibility list](docs/compatibility.md) is the source of truth for supported subsets, missing mappings and unresolved conditions. This roadmap does not replace that list.

## Reliability

- Preserve account and request identity across login, cancellation, retries and restarts.
- Improve artifact validation and recovery without replaying unknown paid operations.
- Keep external runtime availability and local processing requirements explicit.

To propose a capability, explain the user outcome, relevant website behavior, input constraints and a way to verify the result. See [Contributing](CONTRIBUTING.md) and [Support](SUPPORT.md).
