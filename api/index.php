<?php
declare(strict_types=1);

/**
 * Front controller.
 *
 * Every request enters here (see .htaccess). There is no framework and no
 * autoloader: the route table names the file and the function, and only the
 * matched route's file is loaded.
 *
 * Run locally with PHP's built-in server, from the repository root:
 *
 *   php -S 127.0.0.1:8000 api/index.php
 *
 * and call e.g. http://127.0.0.1:8000/api/v1/sync/pull
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/core/errors.php';
require_once __DIR__ . '/core/response.php';
require_once __DIR__ . '/core/auth.php';

errors_install();

/* --------------------------------------------------------------------------
 * CORS
 *
 * The native client sends no Origin header and is unaffected by any of this;
 * CORS only exists for a browser-based debug console. Origins are echoed from
 * an explicit allow-list — never `*`, and never the request's own Origin
 * unchecked. The API is bearer-authenticated and sets no cookies, so
 * Allow-Credentials is deliberately absent.
 * ----------------------------------------------------------------------- */
$origin = (string)($_SERVER['HTTP_ORIGIN'] ?? '');
if ($origin !== '' && in_array($origin, (array)config_get('cors_allowed_origins', []), true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Vary: Origin');
    header('Access-Control-Allow-Headers: Authorization, Content-Type');
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Max-Age: 600');
}
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
}

/* --------------------------------------------------------------------------
 * Path
 * ----------------------------------------------------------------------- */
$uri = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH) ?: '/';
$marker = '/api/v1/';
$position = strpos($uri, $marker);
$path = $position === false ? '' : substr($uri, $position + strlen($marker));
$path = trim($path, '/');
$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

/* --------------------------------------------------------------------------
 * Route table: [method, pattern, file, handler, public?]
 *
 * Capture groups are passed to the handler in order, after the authenticated
 * user (public routes receive only the captures). Patterns are anchored and
 * constrain their captures, so a handler never receives a surprise.
 * ----------------------------------------------------------------------- */
$routes = [
    ['POST', '#^auth/login$#',                    'auth.php',        'route_auth_login',              true],
    ['GET',  '#^auth/me$#',                       'auth.php',        'route_auth_me',                 false],
    ['POST', '#^auth/logout$#',                   'auth.php',        'route_auth_logout',             false],

    ['GET',  '#^sync/pull$#',                     'sync.php',        'route_sync_pull',               false],
    ['POST', '#^sync/push$#',                     'sync.php',        'route_sync_push',               false],

    ['POST', '#^inspections/(\d{1,10})/photos$#', 'inspections.php', 'route_inspection_photo_upload', false],
];

$pathMatched = false;

foreach ($routes as [$routeMethod, $pattern, $file, $handler, $isPublic]) {
    if (preg_match($pattern, $path, $captures) !== 1) {
        continue;
    }
    // Remember that the path exists, so a wrong verb answers 405 and not 404.
    $pathMatched = true;
    if ($routeMethod !== $method) {
        continue;
    }

    require_once __DIR__ . '/routes/' . $file;

    array_shift($captures); // drop the full match

    if ($isPublic) {
        $handler(...$captures);
    } else {
        $handler(auth_require_user(), ...$captures);
    }

    // Handlers always terminate through api_ok()/api_fail(). Reaching this
    // line means one of them returned, which is a bug worth surfacing.
    api_fail('no_response', 'The route produced no response.', 500);
}

if ($pathMatched) {
    api_fail('method_not_allowed', sprintf('%s is not allowed on this endpoint.', $method), 405);
}

api_fail('not_found', 'Unknown endpoint.', 404);
