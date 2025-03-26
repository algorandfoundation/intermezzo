import { LoggingInterceptor } from './logging.interceptor';
import { of } from 'rxjs';
import { ExecutionContext } from '@nestjs/common';

describe('LoggingInterceptor', () => {
  let interceptor: LoggingInterceptor;
  let mockLogger: {
    log: jest.Mock<any, any>;
    verbose: jest.Mock<any, any>;
    debug: jest.Mock<any, any>;
    warn: jest.Mock<any, any>;
    error: jest.Mock<any, any>;
  };

  beforeEach(() => {
    mockLogger = { log: jest.fn(), verbose: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
    interceptor = new LoggingInterceptor();
    (interceptor as any).logger = mockLogger; // directly set the logger
  });

  it('should log the URL and method from the request', () => {
    // Arrange: set up a dummy request with a URL and method.
    const url = '/test';
    const method = 'GET';
    const context: Partial<ExecutionContext> = {
      // Mock getArgs to return an array whose first element mimics the request object.
      getArgs: jest.fn().mockReturnValue([{ url, method }]),
    };

    const next = {
      // next.handle() should return an observable; for this test the value is not important.
      handle: jest.fn(() => of(null)),
    };

    // Act: call the intercept method.
    interceptor.intercept(context as ExecutionContext, next);

    // Assert: expect that logger.log was called with the url and method.
    expect(mockLogger.log).toHaveBeenCalledWith(url, method);
  });

  it('should return the result from next.handle()', (done) => {
    // Arrange: prepare dummy request data and expected response.
    const url = '/another-test';
    const method = 'POST';
    const response = { success: true };
    const context: Partial<ExecutionContext> = {
      getArgs: jest.fn().mockReturnValue([{ url, method }]),
    };

    const next = {
      handle: jest.fn(() => of(response)),
    };

    // Act: intercept and subscribe to the returned observable.
    interceptor.intercept(context as ExecutionContext, next).subscribe((res) => {
      // Assert: expect that the intercepted observable emits the same value from next.handle().
      expect(res).toEqual(response);
      done();
    });
  });
});
