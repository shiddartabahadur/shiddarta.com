---
title: '(RE)Designing Objective-C APIs in Swift'
date: 2021-02-27 22:01:84
category: API
draft: false
showToc: true
---

> This is about the creation of Result type in Swift 5 standard library – and how each of its methods is derived and implemented.

## Introduction

Swift’s very first error handling `API` (i.e. try-throw-catch), was first introduced in Swift 2.0 to allow developers to propagate errors irrespective of the return type. We will re-implement Result from ground-up to understand its design rationale. Many asynchronous APIs in Objective-C handles returned result by accepting two parameters in their completion-handlers: one that handles successful `API` operation, and another to handle if it fails. However, there is a major flaw and it’s especially more evident when we are going re-write it into Swift.

```swift
func failableAPI() throws {}

do {
    try failableAPI()
} catch {
    print(error.localizedDescription)
}
```

However, there is no way for an async function to throw an `error` to its callback closure (the completionHandler). A common workaround is to pass the error into the callback.

```swift
func load(_ callback: (Data?, Error?) -> Void) {
    anotherAsyncAPI { data, error in
        callback(data, error)
    }
}
```

Unfortunately, if we want to have a 100% robust API, our completion block needs to handle all 4 possible code paths:

- Both `data` and error `exist` (not nil)
- Only `error` exists
- Only `data` exists
- Both `data` not exist (nil)

Logically, the API can only have either one of the two outcomes: 2 and 3. However, there is nothing to prevent the codepath of 1 and 4.

## Swift’s type system

`Result` type has been introduced in Swift 5, but in order for us to understand better, we will be re-implementing it step-by-step to understand the design rationale.

The fact that only case 2 and 3 could happen means:

```swift
enum Result {
    case success(Data)
    case failure(Error)
}
```

If we re-implement our `load` function using our `Result` type:

```swift
func load(_ callback: (Result) -> Void) {
    anotherAsyncAPI { data, error in
        if let data = data {
            callback(.success(data))
        } else if let error = error {
            callback(.failure(error))
        } else {
            fatalError("Logically impossible codepath.")
        }
    }
}
```

The advantage of such an implementation is if we forget to handle the error, the Swift compiler will scream at us for ignoring an enum case. So by this point, it is evident that this is better than the (Data?, Error?).

To make code reusable, we can just ‘adapt’ the enum to handle different data types by simply using <a target="_blank" href="https://docs.swift.org/swift-book/LanguageGuide/Generics.html">Generics.</a>

```swift
enum Result<T> {
    case success(T)
    case failure(Error)
}
```

Instead of constraining only Data-type in the success case, it’s now a generic type T. So then, our Result type would no longer be limited to our specific load function.

In case if you want, we can also make Error parameter to confine to a protocol to enforce more fine-grained error handling. But it isn’t required.

```swift
func load(_ callback: (Result<Data>) -> Void)
```

Ok, so let’s explore deeper with these two slightly more complicated functions:

```swift
func loadString( callback: (Result<String>) -> Void) {
    let dateString = "2019-0221T11:24:00+0000"
    callback(.success(dateString))
}

func date(from string: String) throws -> Date {
    let dateFormatter = DateFormatter()
    dateFormatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ssZ"
    dateFormatter.locale = Locale(identifier: "en_US_POSIX")

    guard let date = dateFormatter.date(from:string)

    else { throw OperationError.invalidDateString }
    return date
}
```

`loadString` takes a callback and mocks as an async call to pass back a Result. For simplicity, it’s set to always pass the same string, but of course, we can make it to pass failure too.

Also date(from:) function takes in a string and tries to return a Date. If it fails, it will throw an error, it’s up to the caller how it will be handled. To make things easier, we’ll just have a generic OperationError.invalidDateString error.

We will then create an artificial async function that loads a date “asynchronously” – loading the date string from the loadString function and using the date( from: ) function to parse our date string.

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString { stringResult in
        switch stringResult {
        case .success(let string):
            do {
                let d = try date(from: string)
                callback(.success(d))
            } catch {
                callback(.failure(error))
            }
        case .failure(let e):
            callback(.failure(e))
        }
    }
}
```

In the success-branch of the switch statement, we use `try` to call some throwing function, and transforming its return value (or error) into the expected Result for the callback. We can generalise that.

It seems like the do-catch block is agnostic of the throwing function inside the do-closure. All it cares about is transforming its return value (or thrown error) into a Result. But since we are going to be creating a Result, why not just abstract it by making it an initialiser?

```swift
extension Result {
    init (catching body: () throws -> A) {
        do {
            let result = try body()
            self = .success(result)
        } catch {
            self = .failure(error)
        }
    }
}
```

So this initialiser accepts a throwing closure that transforms its result into our Result type. Using this in our loadDate function:

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString{ stringResult in
        switch stringResult {
        case .success(let string):
            callback(Result {
                try date(from: string)
            })
        case .failure(let e):
            callback(.failure(e))
        }
    }
}
```

Nice! It totally got rid of the do-catch code. Let’s leave it for now.

## Enhancing Result Type

Now that we have a loadDate function, what if we want to create an async function that gets the month of that date? We have to include loadDate in our implementation. Of course, we are given a helper function to extract the month from a given date. Month is an enum with twelve values for each month.

```swift
func getMonth(of date: Date) -> Month {
    switch Calendar.current.component(.month, from:date) {
        case 1: return .jan
        case 2: return .feb
        case 3: return .mar
        case 4: return .apr
        case 5: return .may
        case 6: return .jun
        case 7: return .jul
        case 8: return .aug
        case 9: return .sep
        case 10: return .oct
        case 11: return .nov
        case 12: return .dec
        default: fatalError()
    }
}
```

Let’s start with the signature for loadMonth. The first question to ask is do we need a Result? Or can we just pass back the Int because getMonth never fails?

The answer is yes, we need it because loadDate can fail, so we have to be able to propagate that error. The first pass of the whole function is this.

```swift
func loadMonth(_ callback: (Result<Month>) -> Void) {
    loadDate { dateResult in
        switch dateResult {
        case .success(let date):
            let value = getMonth(of: date)
            callback(.success(value))
        case .failure(let e):
            callback(.failure(e))
        }
    }
}
```

Note that I have named the variable in the success branch a generic name “value” intentionally.

Now let’s write a `loadNumberOfDays` function that gets how many days are in the month that we got. We are also provided with the following method on Month.

```swift
extension Month {

    //ignoring leap years
    func numberOfDays() -> Int {
        switch self {
            case .jan: return 31
            case .feb: return 28
            case .mar: return 31
            case .apr: return 30
            case .may: return 31
            case .jun: return 30
            case .jul: return 31
            case .aug: return 31
            case .sep: return 30
            case .oct: return 31
            case .nov: return 30
            case .dec: return 31
        }
    }
}
```

`loadNumberOfDays` should be very similar to the functions we created before, its implementation looks like this.

```swift
func loadNumberOfDays(_ callback: (Result<Int>) -> Void) {
    loadMonth { monthResult in
        switch monthResult {
        case .success(let month):
            let value = month.numberOfDays()
            callback(.success(value))
        case .failure(let e):
            callback(.failure(e))
        }
    }
}
```

Hang on! It looks suspiciously similar to `loadMonth`! The methods only differ on one line. This must be a pattern we can generalise.

Indeed, when we look closely, the implementations of our async functions are just turning some Result into another Result. For example, `loadMonth` is taking a Result<Date> and turning it into Result<Month>; loadNumberOfDays turns Result<Month> into Result<Int>.

When we focus on `loadMonth`, we can even notice that the implementation details are all in `getMonth(of:)`. This can be seen as taking a function `getMonth(of:)` that goes from (Date) -> Month to (Result<Date>) -> Result<Month>. It somehow “lifted” that function into the Result world.

```swift
map: ((Date) -> Month) -> ((Result<Date>) -> Result<Month>)
// can think of it as "lifting"
```

If you don’t recognise this yet, let us replace `Result` with `Array`, using the natural syntax.

```swift
map: ((Date) -> Month) -> (([Date]) -> [Month])
```

Given a function that knows how to transform `Date` into `Month`. It’s able to return a function that knows how to transform an array of `Month`. Are you able to recognise this higher-order function?

Yes, it’s Map! Usually, we call it as a method on an array, but that signature is not as clear as the one above, which is more symmetric. So let’s implement the map function for `Result` shall we? We are going to implement the method version.

```swift
extension Result {
    func map<B>(_ f: (A) -> B) -> Result<B> {
        switch self {
        case .failure(let e):
            return .failure(e)
        case .success(let value):
            return .success(f(value))
        }
    }
}
```

As we can see, the code in `loadMonth` and `loadNumberOfDays` are very similar.

Let’s rewrite `loadMonth` using our new map method.

```swift
func loadMonth(_ callback: (Result<Month>) -> Void) {
    loadDate { dateResult in
        let monthResult = dateResult.map(getMonth(of:))
        callback(monthResult)
    }
}
```

It has become so short! This is amazing. Let’s try doing it with `loadNumberOfDays`.

```swift
func loadNumberOfDays(_ callback: (Result<Int>) -> Void) {
    loadMonth { monthResult in
        let daysResult = monthResult.map(Month.numberOfDays)
        callback(daysResult)
    }
}
```

`Month.numberOfDays` might look strange to you. But swift actually provides a static version of all instance methods. Unfortunately, the above code doesn’t compile, because of `Month.numberOfDays` signature.

//Month.numberOfDays: (Month) -> (() -> Int)

There are many ways to get rid of the empty tuple, but let’s go around it for now by calling the method directly.

```swift
func loadNumberOfDays(_ callback: (Result<Int>) -> Void) {
    loadMonth { monthResult in
        let daysResult = monthResult.map { $0.numberOfDays() }
        callback(daysResult)
    }
}
```

Now you might feel like there are more things that we can generalise because both of them are calling the callback in another function’s callback. You are right. But we won’t do it today, we don’t have enough tools yet.

## Using map

There is one more function that can benefit from `map` surely, it’s `loadDate`. Let’s try to rewrite it using map.

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString { stringResult in
        let dateResult = stringResult.map(date(from:))
        fatalError()
    }
}
```

Here, we run into our first problem, date(from:) is a throwing function, so we can’t just pass it into `map`. You might want to make `map` have the ability to receive a throwing function. But then you would be mixing up two different error handling solutions, which is not ideal. There should be a better way.

Before finding the final solution, let’s just try to hack it together first.

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString { stringResult in
        let dateResult = stringResult.map { string in
            return Result<Date> {
                try Date(from: string)
            }
        }
        callback(dateResult) // dateResult is type Result<Result<Date>>
    }
}
```

## Nested Result

Here’s to our second problem. We need to return a Result in the `map` because `date(from:)` is a throwing function, but this has created a nested `Result`. So we can’t feed it elegantly into the callback closure.

The first solution might look something like this

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {

    loadString { stringResult in
        let dateResult = stringResult.map { string in
            return Result<Date> {
                try date(from:string)
            }
        }
        switch dateResult {
        case .success(let innerDateResult):
            callback(innerDateResult)
        case .failure(let e):
            callback(.failure(e))
        }
    }
}
```

While it works, we can make it better. In fact, this pattern has come up so much that people are calling it flatMap.

```swift
flatMap: ((A) -> Result<B>) -> ((Result<A>) -> Result<B>)
```

flatMap is similar to map. They are both higher-order functions. It’s able to lift a function that can fail, into the world of Result. Let’s implement it as a method on Result.

```swift
extension Result {
    func flatMap<B>(_ f: (A) -> Result<B>) -> Result<B>  {
        let nestedResult: Result<Result<B>> = map(f)
        switch nestedResult {
        case .success(let result):
            return result
        case .failure(let e):
            return .failure(e)
        }
    }
}
```

It’s straightforward to integrate it into loadDate.

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString { stringResult in
        let dateResult = stringResult.flatMap { string in
            return Result<Date> {
                try date(from:string)
            }
        }
        callback(dateResult)
    }
}
```

## Catching

The first optimisation is the ugly closure in `loadDate`. It creates a `Result` that is returned immediately, and the string parameter is only used once.

This pattern is usually easy to identify. We must be able to turn any throwing function into a function that returns a `Result` right? Indeed, that higher-order function can be seen below.

```swift
func catching<A, B>(_ f: @escaping (A) throws -> B) -> (A) -> Result<B> {
    return { a in
        Result<B> {
            try f(a)
        }
    }
}
```

With this function, we can turn any throwing function that takes in a parameter to a function that returns Result and not throws. For functions with more parameters, we have to implement a different `catching` function for them.

Let’s use it in `loadDate`.

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString { stringResult in
        let dateResult = stringResult.flatMap { string in
            catching(date(from:))(string)
        }
        callback(dateResult)
    }
}
```

Great! By using `catching` we have eliminated the need for using `try`, but it can be more concise since `string` is only used as the argument to the final function call.

```swift
func loadDate(_ callback: (Result<Date>) -> Void) {
    loadString { stringResult in
        let dateResult = stringResult.flatMap(catching(date(from:)))
        callback(dateResult)
    }
}
```

This is some very clean code. To make it more readable, one can assign a function to variables and pass it around.

## Get

However, it’s still useful to quickly get back to the throwing world. So we will create a method on `Result` that quickly lets us bridge the two worlds.

```swift
extension Result {
    func get() throws -> A {
        switch self {
            case .success(let value):
                return value
            case .failure(let e):
                throw e
        }
    }
}
```

## Multiple Operations

To be frank, it’s not practical to create an intermediate method for every new function call right? We probably don’t need loadDate, loadMonth etc. In fact, it’s entirely possible that we only care about `loadNumberOfDays`. So, just chain’em all!

```swift
func loadNumberOfDaysCombined(_ callback: (Result<Int>) -> Void) {
    loadString { stringResult in
        let daysResult = stringResult.flatMap(catching(date(from:)))
            .map(getMonth(of:))
            .map { $0.numberOfDays() }

        callback(daysResult)
    }
}
```

It’s very short – and remember, we have not given up any error handling abilities. Any errors would still be propagated to the callback closure correctly, as it should be.

## Conclusion

Now that we have learned to implement these functions on Result, we can start utilising its potentials. Hopefully, you have started to feel like Array and Result are more alike than they initially appeared to be. Just throwing it as a curveball, have you ever thought of Optional (the infamous “?”) in a similar fashion? And do you also know map exists on Optional?

Although you might not realize, but you have subconsciously learned the fundamental concepts of a ‘container’. As a matter of fact, it’s not a new thing. An array is a container, an Optional is a container, a Dictionary is also a container. These containers are easy to grasp because they all have some kind of instance property holding on to certain objects.

So it gets really weird when we implement Future/Promise who don’t necessarily hold onto a value but just promise to deliver it when the time comes. But that’s for another day. Please let me know if you have any comments, questions, or feedback. Thank you😊
