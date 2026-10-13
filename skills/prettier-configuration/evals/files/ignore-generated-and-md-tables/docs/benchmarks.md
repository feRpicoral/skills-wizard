# Benchmarks

Numbers from the nightly run on a c7g.xlarge. Columns are right-aligned on purpose so each run's diff stays readable.

| Runner   |  req/s |  p50 ms |  p99 ms |
|:---------|-------:|--------:|--------:|
| fastify  | 48,210 |    0.91 |    3.40 |
| express  | 14,876 |    3.02 |   11.85 |
| gateway  | 41,377 |    1.05 |    4.12 |

Run `yarn bench` to reproduce.
