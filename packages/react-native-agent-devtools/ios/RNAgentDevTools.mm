#import "RNAgentDevTools.h"

#if __has_include("ReactNativeAgentDevTools-Swift.h")
#import "ReactNativeAgentDevTools-Swift.h"
#else
#import <ReactNativeAgentDevTools/ReactNativeAgentDevTools-Swift.h>
#endif

// Thin TurboModule shim: argument marshalling and release-build gating only.
// All UIKit work lives in RNADNative.swift and runs on the main queue.

#define RNAD_GUARD(reject)                                                                          \
  if (!RNADNative.isDebuggable) {                                                                   \
    reject(@"RNAD_DISABLED", @"react-native-agent-devtools is disabled in release builds", nil);   \
    return;                                                                                         \
  }

static void (^rejecter(RCTPromiseRejectBlock reject))(NSString *, NSString *)
{
  return ^(NSString *code, NSString *message) {
    reject(code, message, nil);
  };
}

@implementation RNAgentDevTools

+ (NSString *)moduleName
{
  return @"RNAgentDevTools";
}

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

- (dispatch_queue_t)methodQueue
{
  return dispatch_get_main_queue();
}

- (facebook::react::ModuleConstants<JS::NativeRNAgentDevTools::Constants>)constantsToExport
{
  return [self getConstants];
}

- (facebook::react::ModuleConstants<JS::NativeRNAgentDevTools::Constants>)getConstants
{
  return facebook::react::typedConstants<JS::NativeRNAgentDevTools::Constants>({
      .isDebuggable = RNADNative.isDebuggable,
      .isEmulator = RNADNative.isEmulator,
      .model = RNADNative.modelIdentifier,
      .osVersion = RNADNative.osVersion,
      .appName = RNADNative.appName,
      .bundleId = RNADNative.bundleId,
  });
}

- (void)getSafeAreaInsets:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  resolve([RNADNative safeAreaInsets]);
}

- (void)probeViews:(NSArray *)tags
           offsets:(NSArray *)offsets
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  [RNADNative probeWithTags:tags offsets:offsets resolve:resolve];
}

- (void)tap:(NSInteger)tag dx:(double)dx dy:(double)dy resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  [RNADNative tapWithTag:tag resolve:resolve reject:rejecter(reject)];
}

- (void)longPress:(NSInteger)tag
               dx:(double)dx
               dy:(double)dy
       durationMs:(double)durationMs
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject
{
  reject(@"RNAD_UNSUPPORTED", @"iOS has no public API to inject touches in-process", nil);
}

- (void)swipe:(double)x1
           y1:(double)y1
           x2:(double)x2
           y2:(double)y2
   durationMs:(double)durationMs
      resolve:(RCTPromiseResolveBlock)resolve
       reject:(RCTPromiseRejectBlock)reject
{
  reject(@"RNAD_UNSUPPORTED", @"iOS has no public API to inject touches in-process", nil);
}

- (void)typeText:(NSInteger)tag
            text:(NSString *)text
         replace:(BOOL)replace
          submit:(BOOL)submit
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  [RNADNative typeTextWithTag:tag text:text replace:replace submit:submit resolve:resolve reject:rejecter(reject)];
}

- (void)scrollBy:(NSInteger)tag
              dx:(double)dx
              dy:(double)dy
        animated:(BOOL)animated
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  [RNADNative scrollByTag:tag dx:dx dy:dy animated:animated resolve:resolve reject:rejecter(reject)];
}

- (void)pressBack:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  reject(@"RNAD_UNSUPPORTED", @"iOS has no system back action; use navigation.goBack()", nil);
}

- (void)captureScreen:(double)maxWidth
              quality:(double)quality
                boxes:(NSArray *)boxes
               labels:(NSArray *)labels
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  [RNADNative captureWithMaxWidth:maxWidth quality:quality boxes:boxes labels:labels resolve:resolve reject:rejecter(reject)];
}

- (void)getNativeOverlays:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  RNAD_GUARD(reject);
  resolve([RNADNative nativeOverlays]);
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeRNAgentDevToolsSpecJSI>(params);
}

@end
