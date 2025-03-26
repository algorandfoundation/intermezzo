import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger: Logger;
  constructor() {
    this.logger = new Logger('LoggingInterceptor');
  }
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const url = context.getArgs()[0].url;
    const method = context.getArgs()[0].method;
    this.logger.log(url, method);
    return next.handle().pipe();
  }
}
