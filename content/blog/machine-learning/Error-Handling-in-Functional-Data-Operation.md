---
title: 'Error Handling in Functional Data Operation'
date: 2020-05-19 21:01:39
category: iOS
draft: false
showToc: true
---

> `FunctionalDataOperation` implemented previously has hit a bottleneck due to a lack of built-in error handling.

## A few things to note:

- We are now dealing with `FunctionalDataOperation<Result<Element, AnyError>>`. The question is, can we do better?
- This is a follow-up to the article: Making Core Data Functional.
- Before we start, here’s a quick overview of FunctionalDataOperation.

```swift
public struct FunctionalDataOperation<Element> {

    private let operation : (NSManagedObjectContext) -> Element

    public init (_ operation: @escaping (NSManagedObjectContext) -> Element) {
        self.operation = operation
    }

    public func operate(in context: NSManagedObjectContext) -> Element {
        var result: Element!
        context.performAndWait {
            result = operation(context)
        }
        return result
    }

    public func operateAsync(in context: NSManagedObjectContext,
                             _ callback: @escaping (Element) -> Void){
        let operation = self.operation
        context.perform {
            let element = operation(context)
            callback(element)
        }
    }

    public func map<NewElement>(_ f: @escaping (Element) -> NewElement)
        -> FunctionalDataOperation<NewElement> {

        return FunctionalDataOperation<NewElement> { ctx in
            f(self.operate(in: ctx))
        }
    }

    public func flatMap<NewElement>
    (_ f: @escaping (Element) -> FunctionalDataOperation<NewElement>)
        -> FunctionalDataOperation<NewElement> {

        return FunctionalDataOperation<NewElement> { ctx in
            f(self.operate(in: ctx)).operate(in:ctx)
        }
    }
}

public func zip<A, B>

(_ firstOperation: FunctionalDataOperation<A>, _ secondOperation: FunctionalDataOperation<B>)
    -> FunctionalDataOperation<(A,B)> {

    return FunctionalDataOperation { ctx in
        (firstOperation.operate(in:ctx), secondOperation.operate(in:ctx))
    }
}
```

## What’s wrong with FunctionalDataOperation<Result<Element, AnyError>>?

Ok, I’ll briefly show you how things break apart when we perform a flatMap operation on `FunctionalDataOperation<Result<Element,Error>>`.

This is what we have if it were to always return `Result`.

```swift
struct FunctionalDataOperation<Element, Error> {
    private let operation: (NSManagedObjectContext) -> Result<Element, Error>
}
```

And we shall start with implementing a little helper function `fetchOperation` that takes in a fetch request and returns an operation.

```swift
func fetchOperation<ResultType>
( request: NSFetchRequest<ResultType>) -> FunctionalDataOperation<Result<[ResultType],
Error>> {

    return FunctionalDataOperation { context in
        context.fetching(request)
    }
}
}
```

Here we assume – there is a `FunctionalDataOperation` that returns the name of a `Game`.

```swift
let nameOperation: FunctionalDataOperation<Result<String, AnyError>>
```

After that, a function that creates a fetch operation that filters our games by name.

```swift
func fetchGamesOperation(named: String) -> FunctionalDataOperation<Result<[Game], AnyError>> {
    let gameRequest = NSFetchRequest<Game>(entityName: “Game”)
    gameRequest.predicate = NSPredicate(format: “name == %@“, named)
    return fetchOperation(gameRequest)
}
```

Finally, applying `flatMap` to hook these two operations together:

```swift
let filteredGamesOperation = nameOperation.flatMap { nameResult in
    return FunctionalDataOperation { context in
        return nameResult.flatMap { name in
            return fetchGamesOperation(named: name).operate(in: context)
        }
    }
}
}
```

See how that’s total a disaster? It was supposed to be just a simple flatMap.

## Introducing ResultFCD

I was inspired by Haskell’s Data.Either and IO type. IO type is essentially a lazily evaluated closure that we usually put side effects in, like reading from file or printing to console. Quite often, IO has a failure state, which means it will return an Either saying it’s either successful or failed. But having IO<Either<Success, Error>> everywhere would cause the problems we are currently facing, so they created `EitherIO`.

`ResultFDO` follows the name convention of putting the inner container first and then the outer container second. But ResultFunctionalDataOperation is a bit too long, so it’s been shortened down to `ResultFDO`. After all, IO is also an abbreviation, right?

It is straightforward to implement, starting with its only property.

```swift
struct ResultFDO<Element, Error: Swift.Error> {
    let operation: FunctionalDataOperation<Result<Element, Error>>

    init(_ operation: @escaping (NSManagedObjectContext) -> Result<Element, Error>) {
        self.operation = FunctionalDataOperation(operation)
    }
}
```

There’s also a convenience initialiser so we can have a similar syntax to `FunctionalDataOperation` which we could get access to the context directly.

Similarly, it should also have `operate` and `operateAsync`.

```swift
extension ResultFDO{
    func operate(in context: NSManagedObjectContext) -> Result<Element,Error> {
        return operation.operate(in: context)
    }

    func operateAsync
    (in context: NSManagedObjectContext, _ callback: @escaping (Result<Element, Error>) -> Void)
    {
        operation.operateAsync(in: context, callback)
    }
}
```

Along with `map` and `flatMap` operations:

```swift
extension ResultFDO {
    func map<NewElement>
    (_ f: @escaping (Element) -> NewElement) -> ResultFDO<NewElement, Error> {
        return ResultFDO<NewElement, Error>(operation: operation.map { $0.map(f) }
    }

    func flatMap<NewElement>(_ f: @escaping (Element) -> ResultFDO<NewElement, Error>) {
        return ResultFDO<NewElement, Error> { ctx in
            self.operation.operate(in:ctx).flatMap { f($0).operate(in:ctx) }
        }
    }
}
```

I encourage you to try to create it yourself and only reference this when stuck, even though `FlatMap` might seem intimidating at first.

## Error Handling the Right-way

Actually, why are we doing this instead of just using a `typealias`? This wrapper type seems a little redundant, no? Too bad that we can’t write an extension to type alias easily, plus I didn’t think it’s justifiable to extend `FunctionalDataOperation` to constrain its `Element` to a Result. This seemed cleaner.

Comparing `ResultFDO` to `FunctionalDataOperation<Result<Element,Error>>`, now it’s much easier to navigate our minds between various functional operations such as map, flatMap,sequence .

Let’s rewrite fetchOperation function to return ResultFDO instead of a `FunctionalDataOperation`.

```swift
func fetchOperation<ResultType>(_ request: NSFetchRequest<ResultType>) -> ResultFDO<[ResultType]> {
    return ResultFDO { context in
        context.fetching(request)
    }
}
```

And here’s how the calling code would look like:

```swift
let gameRequest = NSFetchRequest<Game>(entityName: “Game”)
let gameOperation: ResultFDO<[Game], AnyError> = fetchOperation(gameRequest)
let gameResult: Result<[Game], AnyError> = gameOperation.operate(in: context)
}
```

Not much has changed, but that was kinda expected. `ResultFDO` was meant to serve as a wrapper type, so it would make sense they have similar APIs.

What about `map`?

```swift
let namesOperation = gameOperation.map { $0.map(getNameSafely) }
// Type: DataOperation<Result<[String],AnyError>
```

That’s exactly what we would expect from a container! There are not extraneous map calls. Then what about `flatMap`?

Similarly, we assume we have a `ResultFDO` that gives us a game’s name.

```swift
let namesOperation: ResultFDO<String, AnyError>
```

And then we rewrite a `fetchGamesOp` in terms of ResultFDO, changing only the return signature.

```swift
func fetchGamesOp(named: String) -> ResultFDO<[Game], AnyError> {
    let gameRequest = NSFetchRequest<Game>(entityName: “Game”)
    gameRequest.predicate = NSPredicate(format: “name == %@“, named)
    return fetchOperation(gameRequest)
}
```

Then finally, we hook them up together.

```swift
let filteredGamesOp: ResultFDO<[Game], AnyError> = nameOperation.flatMap(fetchDogsOp)
```

Sweet! It’s now simplified to just one call.

You might need to spend a bit of time to implement a brand new container and its methods, but it will be worthy of your time if this nested combination is used often enough.

## Doing the Heavy-lifting

In our previous article of (Re)implementing Result type, we talked about using `lift` on nested wrapper types. Its primary purpose is to make it easy for the underlying types to be “lifted” into its world. In our use-case, the underlying types are `FunctionalDataOperation` and `Result`.

So we can implement two `lift` functions that do exactly that.

```swift
//// Lifts a Result into ResultFDO
public func lift<Element, Error>
(_ result: Result<Element, Error>) -> ResultFDO<Element, Error> {
    return ResultFDO { _ in result }
}

//// Lifts a FunctionalDataOperation into a ResultFDO
public func lift<Element, Error>
(_ operation: FunctionalDataOperation<Element>) -> ResultFDO<Element> {
    return ResultFDO(operation: operation.map(Result.success))
}
```

P/S: Result.success is a function shorthand for { Result.success(\$0) } .

These are useful when you have a `FunctionalDataOperation` and you want to use flatMap into a ResultFDO. Instead of calling map on the `FunctionalDataOperation` and getting it a mess, it’s better to just lift it to `ResultFDO` and then call flatMap.

## Conclusion

It is not the purpose of this article to show you the implementation details of `ResultFDO`, rather it is to show you the importance of separating concerns for different containers. For instance, the purpose of `FunctionalDataOperation` is primarily thread management, so it should just focus on that, and we should not introduce the Result type to it. It may sound ironic but the key to making nested containers easy to deal with is by introducing new containers as demonstrated in this article. The upfront cost of doing so is little but can save us a lot of time in the long run.

## Wrapper-ception

I hope this article has inspired you to consider abstracting those nested containers you have been using (and hating all along!). Next up, I will be integrating Point-free’s randomness container `Gen` into `ResultFDO` which would then allow us to have a more controllable seeding of our CoreData context (for testing). Then, I will apply the same concept again to justify another container for wrapping our `ResultFDO` as otherwise, we would need to deal with up to three levels deep of containers.

For any feedback (or just to say hi), hit me up on😊
