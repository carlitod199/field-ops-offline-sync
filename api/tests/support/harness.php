<?php
declare(strict_types=1);

/**
 * A very small test harness.
 *
 * There is no Composer in this project, so there is no PHPUnit. Rather than
 * add a dependency manager for one purpose, the suite is a few hundred lines
 * of plain PHP: register named cases, run them, report. It supports what these
 * tests actually need — assertions, expected exceptions, and skipping a group
 * with a stated reason when its prerequisite is missing — and nothing else.
 */

final class TestRun
{
    /** @var array<int, array{group: string, name: string, body: callable}> */
    private static array $cases = [];

    private static ?string $currentGroup = null;

    private static int $passed = 0;
    private static int $failed = 0;
    private static int $skipped = 0;
    private static int $assertions = 0;

    /** @var array<int, string> */
    private static array $failures = [];

    public static function group(string $name): void
    {
        self::$currentGroup = $name;
    }

    public static function case(string $name, callable $body): void
    {
        self::$cases[] = ['group' => self::$currentGroup ?? 'ungrouped', 'name' => $name, 'body' => $body];
    }

    /** Marks every case registered from here on in this file as skipped. */
    public static function skipGroup(string $group, string $reason): void
    {
        self::$skipped++;
        echo sprintf("  SKIP %s\n       %s\n", $group, $reason);
    }

    public static function countAssertion(): void
    {
        self::$assertions++;
    }

    public static function run(): int
    {
        $group = null;
        foreach (self::$cases as $case) {
            if ($case['group'] !== $group) {
                $group = $case['group'];
                echo "\n" . $group . "\n";
            }
            try {
                ($case['body'])();
                self::$passed++;
                echo '  ok   ' . $case['name'] . "\n";
            } catch (AssertionFailed $e) {
                self::$failed++;
                self::$failures[] = $group . ' / ' . $case['name'] . ': ' . $e->getMessage();
                echo '  FAIL ' . $case['name'] . "\n       " . $e->getMessage() . "\n";
            } catch (Throwable $e) {
                self::$failed++;
                self::$failures[] = $group . ' / ' . $case['name'] . ': ' . $e::class . ' ' . $e->getMessage();
                echo '  ERR  ' . $case['name'] . "\n       " . $e::class . ': ' . $e->getMessage()
                    . "\n       " . $e->getFile() . ':' . $e->getLine() . "\n";
            }
        }

        echo sprintf(
            "\n%d passed, %d failed, %d group(s) skipped, %d assertions\n",
            self::$passed,
            self::$failed,
            self::$skipped,
            self::$assertions
        );

        if (self::$failures !== []) {
            echo "\nFailures:\n";
            foreach (self::$failures as $failure) {
                echo '  - ' . $failure . "\n";
            }
        }

        return self::$failed === 0 ? 0 : 1;
    }
}

final class AssertionFailed extends RuntimeException
{
}

function test_group(string $name): void
{
    TestRun::group($name);
}

function test_case(string $name, callable $body): void
{
    TestRun::case($name, $body);
}

function test_skip_group(string $group, string $reason): void
{
    TestRun::skipGroup($group, $reason);
}

function fail_assertion(string $message): never
{
    throw new AssertionFailed($message);
}

/** Strict equality, with a readable diff for scalars and arrays. */
function assert_same(mixed $expected, mixed $actual, string $context = ''): void
{
    TestRun::countAssertion();
    if ($expected === $actual) {
        return;
    }
    fail_assertion(sprintf(
        '%sexpected %s, got %s',
        $context === '' ? '' : $context . ': ',
        var_export($expected, true),
        var_export($actual, true)
    ));
}

function assert_true(mixed $value, string $context = ''): void
{
    assert_same(true, $value, $context);
}

function assert_false(mixed $value, string $context = ''): void
{
    assert_same(false, $value, $context);
}

function assert_null(mixed $value, string $context = ''): void
{
    assert_same(null, $value, $context);
}

/** Asserts that $body throws, and that the thrown class matches. */
function assert_throws(string $expectedClass, callable $body, string $context = ''): Throwable
{
    TestRun::countAssertion();
    try {
        $body();
    } catch (Throwable $e) {
        if (!($e instanceof $expectedClass)) {
            fail_assertion(sprintf(
                '%sexpected %s, got %s (%s)',
                $context === '' ? '' : $context . ': ',
                $expectedClass,
                $e::class,
                $e->getMessage()
            ));
        }
        return $e;
    }
    fail_assertion(sprintf('%sexpected %s, nothing was thrown', $context === '' ? '' : $context . ': ', $expectedClass));
}
