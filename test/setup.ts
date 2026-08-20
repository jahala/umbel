// Preloaded before every test file (see bunfig.toml).
//
// Pins the whole test run to one tmux socket of its own. Two things fall out of
// that, both load-bearing:
//
//   • Test sessions cannot collide with real workers. umbel derives its socket
//     from the state root, and tests use a temp UMBEL_STATE per file — so
//     without this, a test that creates a session through the operations layer
//     and asserts on it through the adapter would be looking at two different
//     sockets. The override makes every call in the process agree.
//
//   • Nothing a test does can reach a live worker. Previously umbel put every
//     session on the shared default socket, and a test run reaped other agents'
//     running workers — silently, because a vanished session leaves no pane and
//     no log. A private socket makes that structurally impossible rather than a
//     thing to remember.
//
// Per-run id so concurrent runs on one machine stay out of each other's way.
process.env.UMBEL_TMUX_SOCKET ??= `umbel-test-${process.pid}`;
