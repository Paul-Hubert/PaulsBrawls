# Paul's Brawls - Development Automation

This document describes the comprehensive automation system for Paul's Brawls Minecraft mod development.

## 🚀 Quick Start

### Basic Development Cycle
```powershell
# Build and test
.\dev-automation.ps1 -Action build-test

# Deploy to server
.\dev-automation.ps1 -Action deploy -ServerPath "C:\Minecraft\Server"

# Watch files and auto-rebuild
.\watch-files.ps1 -ServerPath "C:\Minecraft\Server" -AutoRestart
```

## 📋 Available Scripts

### 1. Development Automation (`dev-automation.ps1`)

Main automation script for build, test, and deployment tasks.

**Usage:**
```powershell
.\dev-automation.ps1 -Action <action> [options]
```

**Actions:**
- `build` - Build the project
- `test` - Run tests
- `build-test` - Build and test
- `deploy` - Build and copy to mods folders
- `restart-server` - Stop server, build, copy mod, start server
- `watch` - Watch files and auto-rebuild
- `clean` - Clean build directory
- `help` - Show help

**Options:**
- `-ServerPath <path>` - Path to Minecraft server directory
- `-ClientPath <path>` - Path to Minecraft client mods directory
- `-Watch` - Enable file watching
- `-Verbose` - Enable verbose output

**Examples:**
```powershell
# Basic build
.\dev-automation.ps1 -Action build

# Deploy to server
.\dev-automation.ps1 -Action deploy -ServerPath "C:\Minecraft\Server"

# Full restart cycle
.\dev-automation.ps1 -Action restart-server -ServerPath "C:\Minecraft\Server"
```

### 2. File Watcher (`watch-files.ps1`)

Advanced file watching with intelligent debouncing and smart rebuilds.

**Usage:**
```powershell
.\watch-files.ps1 [options]
```

**Options:**
- `-WatchPath <path>` - Directory to watch (default: src)
- `-ServerPath <path>` - Minecraft server directory
- `-ClientPath <path>` - Minecraft client mods directory
- `-DebounceMs <ms>` - Debounce time in milliseconds (default: 2000)
- `-TestOnChange` - Run tests on file changes
- `-AutoRestart` - Auto-restart server after build
- `-Verbose` - Enable verbose output

**Examples:**
```powershell
# Basic watching
.\watch-files.ps1

# Watch with auto-restart
.\watch-files.ps1 -ServerPath "C:\Minecraft\Server" -AutoRestart

# Watch with testing
.\watch-files.ps1 -TestOnChange -DebounceMs 3000
```

### 3. Test Automation (`test-automation.ps1`)

Comprehensive testing framework with multiple test types.

**Usage:**
```powershell
.\test-automation.ps1 -TestType <type> [options]
```

**Test Types:**
- `all` - Run all tests
- `unit` - Run unit tests only
- `integration` - Run integration tests only
- `performance` - Run performance tests only
- `report` - Generate test report only

**Options:**
- `-Verbose` - Enable verbose output
- `-GenerateReport` - Generate HTML test report

**Examples:**
```powershell
# Run all tests
.\test-automation.ps1 -TestType all

# Run unit tests with report
.\test-automation.ps1 -TestType unit -GenerateReport
```

## 🔧 Gradle Tasks

The build system includes custom Gradle tasks for development:

### Development Tasks
- `devBuild` - Build the project and copy to mods folders
- `devTest` - Run tests and build if successful
- `devClean` - Clean build directory and remove mods
- `devRestart` - Full development cycle: clean, build, test, deploy
- `devWatch` - Watch for file changes and auto-rebuild

### Quick Tasks
- `quickBuild` - Quick build without tests
- `quickTest` - Quick test without full build

**Usage:**
```bash
# Using Gradle directly
./gradlew devBuild
./gradlew devTest
./gradlew devRestart

# Using PowerShell scripts (recommended)
.\dev-automation.ps1 -Action build
```

## 🧪 Testing Framework

### Test Structure
```
src/test/java/com/paul/brawl/
├── TestRunner.java           # Main test runner
├── ModIntegrationTest.java  # Integration tests
└── [Additional test files]
```

### Test Types
1. **Unit Tests** - Test individual components
2. **Integration Tests** - Test component interactions
3. **Performance Tests** - Test performance characteristics
4. **Security Tests** - Test security aspects

### Running Tests
```powershell
# Run all tests
.\test-automation.ps1 -TestType all

# Run specific test types
.\test-automation.ps1 -TestType unit
.\test-automation.ps1 -TestType integration
.\test-automation.ps1 -TestType performance

# Generate test reports
.\test-automation.ps1 -TestType report -GenerateReport
```

## 🔄 CI/CD Pipeline

### GitHub Actions Workflows

#### 1. Main CI Pipeline (`.github/workflows/ci.yml`)
- Runs on push/PR to main branches
- Tests, builds, and creates releases
- Includes security scanning
- Generates test reports

#### 2. Development Automation (`.github/workflows/dev-automation.yml`)
- Manual workflow dispatch
- Supports all development actions
- Uploads artifacts and reports

### Local CI Simulation
```powershell
# Simulate full CI pipeline
.\dev-automation.ps1 -Action clean
.\dev-automation.ps1 -Action build-test
.\test-automation.ps1 -TestType all -GenerateReport
```

## 📊 Monitoring and Reporting

### Build Reports
- Test results: `build/reports/tests/`
- Test results data: `build/test-results/`
- Security reports: `build/reports/dependency-check/`

### Logs and Output
- Build logs: Console output with color coding
- Test results: HTML and XML reports
- Error tracking: Detailed error messages

## 🛠️ Configuration

### Environment Variables
```bash
# OpenAI API Configuration
OPENAI_API_KEY=your_api_key
OPENAI_ORG_ID=your_org_id
OPENAI_PROJECT_ID=your_project_id

# Gradle Configuration
GRADLE_OPTS=-Xmx2g
```

### Gradle Properties
Update `gradle.properties` with your paths:
```properties
# Mod deployment paths
mods_folder=C:\Minecraft\Server\mods
client_mods_folder=C:\Minecraft\Client\mods
```

## 🚨 Troubleshooting

### Common Issues

1. **Build Failures**
   ```powershell
   # Clean and rebuild
   .\dev-automation.ps1 -Action clean
   .\dev-automation.ps1 -Action build
   ```

2. **Test Failures**
   ```powershell
   # Run tests with verbose output
   .\test-automation.ps1 -TestType all -Verbose
   ```

3. **File Watcher Issues**
   ```powershell
   # Restart with different settings
   .\watch-files.ps1 -DebounceMs 5000 -Verbose
   ```

4. **Server Connection Issues**
   - Verify server path is correct
   - Check server is running
   - Ensure mods folder exists

### Debug Mode
```powershell
# Enable verbose output for all scripts
.\dev-automation.ps1 -Action build -Verbose
.\test-automation.ps1 -TestType all -Verbose
.\watch-files.ps1 -Verbose
```

## 📈 Performance Optimization

### Build Optimization
- Use `quickBuild` for rapid iteration
- Enable Gradle daemon
- Use build cache

### Test Optimization
- Run specific test types
- Use parallel execution
- Cache test results

### File Watching Optimization
- Adjust debounce time
- Use specific watch paths
- Ignore unnecessary files

## 🔒 Security

### API Key Management
- Use environment variables
- Never commit API keys
- Use secure storage

### Dependency Scanning
- Regular security scans
- Update dependencies
- Monitor vulnerabilities

## 📚 Best Practices

### Development Workflow
1. Use file watcher for active development
2. Run tests before committing
3. Use CI/CD for validation
4. Keep dependencies updated

### Code Quality
1. Write comprehensive tests
2. Use consistent formatting
3. Document complex logic
4. Follow security practices

### Performance
1. Monitor build times
2. Optimize test execution
3. Use appropriate caching
4. Profile when needed

## 🤝 Contributing

### Adding New Tests
1. Create test class in `src/test/java/com/paul/brawl/`
2. Follow naming conventions
3. Add to appropriate test suite
4. Update documentation

### Adding New Automation
1. Extend existing scripts
2. Add new Gradle tasks
3. Update CI/CD workflows
4. Test thoroughly

## 📞 Support

For issues or questions:
1. Check this documentation
2. Review error logs
3. Test with verbose output
4. Create issue with details

---

**Happy coding! 🎮**
