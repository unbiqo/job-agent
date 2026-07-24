import { NextRequest, NextResponse } from 'next/server';

/** Basic auth для дашборда (личные данные!). Пустой DASHBOARD_PASSWORD = без защиты. */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.startsWith('/api/telegram')) return NextResponse.next(); // webhook защищён секретом Telegram

  const pass = process.env.DASHBOARD_PASSWORD;
  if (!pass) return NextResponse.next();
  const user = process.env.DASHBOARD_USER || 'admin';
  const expected = 'Basic ' + btoa(`${user}:${pass}`);
  if (req.headers.get('authorization') === expected) return NextResponse.next();
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="JobAgent"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
