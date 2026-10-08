// tests.hpp -- internal unit tests (rule invariants + AI behaviour)

#pragma once

#include <string>
#include <utility>
#include <vector>

namespace weiqi {

struct TestResult {
    int passed = 0;
    int failed = 0;
    std::vector<std::pair<std::string, std::string>> failures;

    static TestResult empty() { return TestResult(); }
};

TestResult run_unit_tests();

}  // namespace weiqi
