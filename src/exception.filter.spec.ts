import { ArgumentsHost, HttpException, HttpStatus } from '@nestjs/common';
import { ExceptionsFilter } from './exception.filter';

describe('ExceptionsFilter', () => {
  let filter: ExceptionsFilter;
  let mockArgumentsHost: ArgumentsHost;
  let mockResponse: any;
  let mockRequest: any;

  beforeEach(() => {
    filter = new ExceptionsFilter();
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockRequest = {
      url: '/test-url',
      method: 'GET',
    };
    mockArgumentsHost = {
      switchToHttp: jest.fn().mockReturnValue({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as any;
  });

  it('should handle HttpException', () => {
    const exception = new HttpException('Test exception', HttpStatus.BAD_REQUEST);
    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.BAD_REQUEST,
      timestamp: expect.any(String),
      path: '/test-url',
      method: 'GET',
      response: 'Test exception',
    });
  });

  it('should handle non-HttpException', () => {
    const exception = new Error('Some error');
    filter.catch(exception, mockArgumentsHost);

    expect(mockResponse.status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(mockResponse.json).toHaveBeenCalledWith({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      timestamp: expect.any(String),
      path: '/test-url',
      method: 'GET',
      response: { message: 'Internal server error' },
    });
  });
});
