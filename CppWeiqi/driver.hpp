// driver.hpp -- JSON-stdio driver entry point (docs/PROTOCOL_SPEC.md, protocol-v1)

#pragma once

namespace weiqi {

// Run the ready-event + request/response loop over stdin/stdout. Returns exit code.
int run_driver();

}  // namespace weiqi
