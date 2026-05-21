import { ExceptionFilter, Catch, ArgumentsHost, HttpException, HttpStatus, Logger } from '@nestjs/common';

@Catch()
export class ExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ExceptionsFilter.name);

  catch(exception: any, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    let status: HttpStatus;
    let message: string | object;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.getResponse();
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = { message: 'Internal server error' };
    }

    // Always log the underlying exception so unhandled errors surface in the
    // server logs instead of being silently masked behind "Internal server error".
    if (status >= 500) {
      const stack = exception instanceof Error ? exception.stack : undefined;
      const detail = exception instanceof Error ? exception.message : String(exception);
      this.logger.error(`Unhandled exception on ${request.method} ${request.url}: ${detail}`, stack);
    }

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      response: message,
    });
  }
}
