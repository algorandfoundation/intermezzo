import { AuthModule } from './auth.module';
import { VaultModule } from '../vault/vault.module';
import { JwtModule } from '@nestjs/jwt';
import { Auth } from './auth.controller';
import { AuthService } from './auth.service';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth.gard';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';

describe('AuthModule', () => {
  let authModule: AuthModule;
  let testingModule: TestingModule;

  beforeEach(async () => {
    testingModule = await Test.createTestingModule({
      imports: [AuthModule, VaultModule, JwtModule, ConfigModule],
    }).compile();
    authModule = testingModule.get<AuthModule>(AuthModule);
  });

  it('should be defined', () => {
    expect(authModule).toBeDefined();
  });

  it('should import VaultModule', () => {
    const imports = Reflect.getMetadata('imports', AuthModule);
    expect(imports).toContain(VaultModule);
  });

  it('should import JwtModule', () => {
    const imports = Reflect.getMetadata('imports', AuthModule);
    const jwtModuleImport = imports.find((imported) => imported['module'] === JwtModule);
    expect(jwtModuleImport).toBeDefined();
  });

  it('should import ConfigModule', () => {
    const imports = Reflect.getMetadata('imports', AuthModule);
    expect(imports).toContain(ConfigModule);
  });

  it('should have Auth controller', () => {
    const controllers = Reflect.getMetadata('controllers', AuthModule);
    expect(controllers).toContain(Auth);
  });

  it('should have AuthService provider', () => {
    const providers = Reflect.getMetadata('providers', AuthModule);
    expect(providers).toContain(AuthService);
  });

  it('should provide APP_GUARD with AuthGuard', () => {
    const providers = Reflect.getMetadata('providers', AuthModule);
    const appGuardProvider = providers.find((provider) => provider['provide'] === APP_GUARD);
    expect(appGuardProvider['useClass']).toBe(AuthGuard);
  });

  it('JwtModule should be globally configured', () => {
    const imports = Reflect.getMetadata('imports', AuthModule);
    const jwtModuleConfig = imports.find((imported) => imported['module'] === JwtModule);
    expect(jwtModuleConfig).toBeDefined();
    expect(jwtModuleConfig['global']).toBe(true);
  });
});
